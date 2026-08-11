import type { SQSEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetIPSetCommand, UpdateIPSetCommand, WAFV2Client, type Scope } from '@aws-sdk/client-wafv2';

const env = {
  tableName: process.env.TABLE_NAME!,
  // Maps each tenant to the IPSet that fronts its CMS. Owned by Terraform, so
  // onboarding a tenant is a config change, never a code change.
  configTableName: process.env.CONFIG_TABLE_NAME!,
  // Ops/break-glass ranges added to every IPSet, so an empty table can never
  // lock everyone out of the CMS.
  breakGlass: (process.env.BREAK_GLASS_CIDRS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
};

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const waf = new WAFV2Client({});

type TenantConfig = { tenantId: string; ipSetId: string; ipSetName: string; ipSetScope: Scope };
type Allowlist = { tenantId: string; cidrs: string[]; version: number; syncedVersion?: number };

/**
 * Reconciles every WAF IPSet from the allowlist table.
 *
 * Tenants that share an IPSet get the union of their lists; tenants with their
 * own IPSet get only theirs. Both fall out of the same grouping, so the shared
 * and per-tenant models are one code path, not two.
 *
 * The message is only a signal - the state is rebuilt from the tables - so
 * retries, redelivery and the scheduled drift check all converge.
 */
export async function handler(event: SQSEvent): Promise<void> {
  const trigger = parseTrigger(event);
  console.log(
    JSON.stringify({
      msg: 'sync triggered',
      records: event.Records.length,
      scope: trigger === 'all' ? 'all' : [...trigger],
    }),
  );

  const [configs, allowlists] = await Promise.all([readConfigs(), readAllowlists()]);
  const byTenant = new Map(allowlists.map((item) => [item.tenantId, item]));

  const unconfigured = allowlists.filter(
    (item) =>
      (trigger === 'all' || trigger.has(item.tenantId)) &&
      !configs.some((c) => c.tenantId === item.tenantId),
  );
  if (unconfigured.length > 0) {
    // Their changes cannot be applied anywhere. They stay PENDING, which is the
    // honest answer, and this log is the signal to add the Terraform entry.
    console.error(
      JSON.stringify({
        msg: 'tenants have no IPSet mapping',
        tenants: unconfigured.map((item) => item.tenantId),
      }),
    );
  }

  const applied: Allowlist[] = [];
  const failures: { ipSetName: string; error: string }[] = [];

  // One IPSet may serve several tenants; reconcile each IPSet exactly once.
  for (const [ipSetId, group] of groupByIpSet(configs)) {
    // Only touch IPSets this trigger actually affects. Two tenants on separate
    // IPSets are separate message groups, so their invocations run in parallel
    // and neither redoes the other's work.
    if (trigger !== 'all' && !group.tenantIds.some((id) => trigger.has(id))) continue;

    const tenants = group.tenantIds.map((id) => byTenant.get(id)).filter(Boolean) as Allowlist[];
    const desired = [...new Set([...env.breakGlass, ...tenants.flatMap((t) => t.cidrs)])].sort();

    try {
      await reconcile(group.config, desired);
      applied.push(...tenants);
    } catch (err) {
      // Keep going: one tenant's WAF problem must not block every other tenant.
      failures.push({ ipSetName: group.config.ipSetName, error: String(err) });
      console.error(JSON.stringify({ msg: 'ipset sync failed', ipSetId, error: String(err) }));
    }
  }

  await confirmApplied(applied);

  // Fail the batch only after the healthy IPSets are done, so the redelivery
  // retries the rest rather than redoing everything from scratch.
  if (failures.length > 0) {
    throw new Error(`failed to reconcile ${failures.length} IPSet(s): ${JSON.stringify(failures)}`);
  }
}

/**
 * Works out which tenants this batch is about.
 *
 * Each message is one stream record carrying its tenant, so an ordinary edit
 * reconciles only that tenant's IPSet. Anything else - the scheduled drift
 * check, a manual invoke, a body we cannot read - falls back to a full sweep,
 * because being slow is a better failure than silently skipping an IPSet.
 */
function parseTrigger(event: SQSEvent): Set<string> | 'all' {
  const tenantIds = new Set<string>();

  for (const record of event.Records ?? []) {
    try {
      const body = JSON.parse(record.body) as {
        dynamodb?: { Keys?: { tenantId?: { S?: string } } };
      };
      const tenantId = body.dynamodb?.Keys?.tenantId?.S;

      if (!tenantId) return 'all';
      tenantIds.add(tenantId);
    } catch {
      return 'all';
    }
  }

  return tenantIds.size > 0 ? tenantIds : 'all';
}

function groupByIpSet(configs: TenantConfig[]) {
  const groups = new Map<string, { config: TenantConfig; tenantIds: string[] }>();

  for (const config of configs) {
    const group = groups.get(config.ipSetId);
    if (group) group.tenantIds.push(config.tenantId);
    else groups.set(config.ipSetId, { config, tenantIds: [config.tenantId] });
  }

  return groups;
}

async function reconcile(config: TenantConfig, desired: string[]): Promise<void> {
  const current = await waf.send(
    new GetIPSetCommand({ Id: config.ipSetId, Name: config.ipSetName, Scope: config.ipSetScope }),
  );

  const existing = [...(current.IPSet?.Addresses ?? [])].sort();
  if (existing.length === desired.length && existing.every((cidr, i) => cidr === desired[i])) {
    console.log(JSON.stringify({ msg: 'ipset already in sync', ipSet: config.ipSetName }));
    return;
  }

  await waf.send(
    new UpdateIPSetCommand({
      Id: config.ipSetId,
      Name: config.ipSetName,
      Scope: config.ipSetScope,
      Addresses: desired,
      // Optimistic lock: a concurrent change fails the call, the message is
      // redelivered, and the next attempt reconciles from a fresh read.
      LockToken: current.LockToken,
    }),
  );

  console.log(
    JSON.stringify({
      msg: 'ipset updated',
      ipSet: config.ipSetName,
      before: existing.length,
      after: desired.length,
    }),
  );
}

async function readConfigs(): Promise<TenantConfig[]> {
  const configs: TenantConfig[] = [];
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await ddb.send(
      new ScanCommand({ TableName: env.configTableName, ExclusiveStartKey: startKey }),
    );

    for (const item of page.Items ?? []) {
      configs.push({
        tenantId: String(item.tenantId),
        ipSetId: String(item.ipSetId),
        ipSetName: String(item.ipSetName),
        ipSetScope: String(item.ipSetScope ?? 'REGIONAL') as Scope,
      });
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  return configs;
}

async function readAllowlists(): Promise<Allowlist[]> {
  const allowlists: Allowlist[] = [];
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: env.tableName,
        // `version` is a DynamoDB reserved word, hence the alias.
        ProjectionExpression: 'tenantId, cidrs, #v, syncedVersion',
        ExpressionAttributeNames: { '#v': 'version' },
        ExclusiveStartKey: startKey,
        // Strongly consistent: a default (eventually consistent) scan can miss
        // the very write that triggered this invocation, which would publish a
        // stale IPSet and leave it stale until the next tenant edit.
        ConsistentRead: true,
      }),
    );

    for (const item of page.Items ?? []) {
      allowlists.push({
        tenantId: String(item.tenantId),
        cidrs: (item.cidrs as string[]) ?? [],
        version: Number(item.version ?? 0),
        syncedVersion: item.syncedVersion === undefined ? undefined : Number(item.syncedVersion),
      });
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  return allowlists;
}

/**
 * Records which version is live in WAF, so the API can report APPLIED instead
 * of guessing. Only tenants whose latest version is not yet acknowledged are
 * written, so a routine sync of an unchanged platform costs no writes.
 *
 * The conditional write is what keeps this honest: if a tenant saved again
 * between the scan and here, that newer version was never in the IPSet, so the
 * update is rejected and the tenant correctly stays PENDING until its own
 * message is processed.
 *
 * These writes are filtered out of the stream by the EventBridge Pipe (they
 * carry `syncedVersion`, tenant edits never do), so they cannot re-trigger this
 * function.
 */
async function confirmApplied(tenants: Allowlist[]): Promise<void> {
  const pending = tenants.filter((tenant) => tenant.syncedVersion !== tenant.version);
  if (pending.length === 0) return;

  const syncedAt = new Date().toISOString();

  const results = await Promise.allSettled(
    pending.map((tenant) =>
      ddb.send(
        new UpdateCommand({
          TableName: env.tableName,
          Key: { tenantId: tenant.tenantId },
          UpdateExpression: 'SET syncedVersion = #v, syncedAt = :syncedAt',
          ConditionExpression: '#v = :expected',
          ExpressionAttributeNames: { '#v': 'version' },
          ExpressionAttributeValues: { ':expected': tenant.version, ':syncedAt': syncedAt },
        }),
      ),
    ),
  );

  const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  const superseded = rejected.filter(
    (r) => (r.reason as Error).name === 'ConditionalCheckFailedException',
  ).length;
  const failed = rejected.filter(
    (r) => (r.reason as Error).name !== 'ConditionalCheckFailedException',
  );

  console.log(
    JSON.stringify({
      msg: 'sync acknowledged',
      confirmed: results.length - superseded - failed.length,
      superseded,
    }),
  );

  // WAF is already correct, so do not fail the batch over a bookkeeping write;
  // the next sync retries it, and the tenant sees PENDING in the meantime.
  if (failed.length > 0) {
    console.error(
      JSON.stringify({
        msg: 'could not acknowledge every tenant',
        count: failed.length,
        error: String(failed[0].reason),
      }),
    );
  }
}
