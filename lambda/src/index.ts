import type { SQSEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetIPSetCommand, UpdateIPSetCommand, WAFV2Client, type Scope } from '@aws-sdk/client-wafv2';

type Tenant = { tableName: string; ipSetId: string; ipSetName: string; ipSetScope: Scope };
type Allowlist = { ownerId: string; cidrs: string[]; version: number; syncedVersion?: number };

const env = {
  // Tenant -> its table and IPSet, written by Terraform. Onboarding a tenant is
  // an apply, never a code change.
  tenants: JSON.parse(process.env.TENANTS ?? '{}') as Record<string, Tenant>,
  // Ops/break-glass ranges added to every IPSet, so an empty table can never
  // lock everyone out of the CMS.
  breakGlass: (process.env.BREAK_GLASS_CIDRS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
};

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const waf = new WAFV2Client({});

/**
 * Reconciles each tenant's IPSet from that tenant's table: one table, one IPSet.
 * Agencies sharing a tenant share its table, so their ranges are simply the
 * union of the items in it.
 *
 * The message is only a signal - state is rebuilt from the table - so retries,
 * redelivery and the scheduled drift check all converge.
 */
export async function handler(event: SQSEvent): Promise<void> {
  const trigger = parseTrigger(event);
  const targets = Object.entries(env.tenants).filter(
    ([, tenant]) => trigger === 'all' || trigger.has(tenant.tableName),
  );

  console.log(
    JSON.stringify({
      msg: 'sync triggered',
      records: event.Records?.length ?? 0,
      tenants: targets.map(([id]) => id),
    }),
  );

  const failures: { tenant: string; error: string }[] = [];

  for (const [id, tenant] of targets) {
    try {
      const allowlists = await readAllowlists(tenant.tableName);
      const desired = [
        ...new Set([...env.breakGlass, ...allowlists.flatMap((item) => item.cidrs)]),
      ].sort();

      await reconcile(tenant, desired);
      await confirmApplied(tenant.tableName, allowlists);
    } catch (err) {
      // Keep going: one tenant's problem must not block every other tenant.
      failures.push({ tenant: id, error: String(err) });
      console.error(JSON.stringify({ msg: 'tenant sync failed', tenant: id, error: String(err) }));
    }
  }

  // Fail only after the healthy tenants are done, so redelivery retries the
  // rest rather than redoing everything.
  if (failures.length > 0) {
    throw new Error(`failed to reconcile ${failures.length} tenant(s): ${JSON.stringify(failures)}`);
  }
}

/**
 * Works out which tables this batch is about, from the stream ARN each record
 * carries. Anything else - the drift check, a manual invoke, a body we cannot
 * read - is a full sweep: being slow beats silently skipping an IPSet.
 */
function parseTrigger(event: SQSEvent): Set<string> | 'all' {
  const tables = new Set<string>();

  for (const record of event.Records ?? []) {
    try {
      const { eventSourceARN } = JSON.parse(record.body) as { eventSourceARN?: string };
      const table = eventSourceARN?.match(/:table\/([^/]+)/)?.[1];

      if (!table) return 'all';
      tables.add(table);
    } catch {
      return 'all';
    }
  }

  return tables.size > 0 ? tables : 'all';
}

async function reconcile(tenant: Tenant, desired: string[]): Promise<void> {
  const current = await waf.send(
    new GetIPSetCommand({ Id: tenant.ipSetId, Name: tenant.ipSetName, Scope: tenant.ipSetScope }),
  );

  const existing = [...(current.IPSet?.Addresses ?? [])].sort();
  if (existing.length === desired.length && existing.every((cidr, i) => cidr === desired[i])) {
    console.log(JSON.stringify({ msg: 'ipset already in sync', ipSet: tenant.ipSetName }));
    return;
  }

  await waf.send(
    new UpdateIPSetCommand({
      Id: tenant.ipSetId,
      Name: tenant.ipSetName,
      Scope: tenant.ipSetScope,
      Addresses: desired,
      // Optimistic lock: a concurrent change fails the call, the message is
      // redelivered, and the next attempt reconciles from a fresh read.
      LockToken: current.LockToken,
    }),
  );

  console.log(
    JSON.stringify({
      msg: 'ipset updated',
      ipSet: tenant.ipSetName,
      before: existing.length,
      after: desired.length,
    }),
  );
}

async function readAllowlists(tableName: string): Promise<Allowlist[]> {
  const allowlists: Allowlist[] = [];
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        // `version` is a DynamoDB reserved word, hence the alias.
        ProjectionExpression: 'ownerId, cidrs, #v, syncedVersion',
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
        ownerId: String(item.ownerId),
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
 * of guessing. Only unacknowledged items are written, so a routine sync of an
 * unchanged platform costs no writes.
 *
 * The conditional write keeps this honest: if the item was saved again between
 * the scan and here, that newer version was never in the IPSet, so the update
 * is rejected and it correctly stays PENDING until its own message arrives.
 *
 * The Pipe filters these writes out of the stream (they carry `syncedVersion`,
 * tenant edits never do), so they cannot re-trigger this function.
 */
async function confirmApplied(tableName: string, items: Allowlist[]): Promise<void> {
  const pending = items.filter((item) => item.syncedVersion !== item.version);
  if (pending.length === 0) return;

  const syncedAt = new Date().toISOString();

  const results = await Promise.allSettled(
    pending.map((item) =>
      ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { ownerId: item.ownerId },
          UpdateExpression: 'SET syncedVersion = #v, syncedAt = :syncedAt',
          ConditionExpression: '#v = :expected',
          ExpressionAttributeNames: { '#v': 'version' },
          ExpressionAttributeValues: { ':expected': item.version, ':syncedAt': syncedAt },
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
      table: tableName,
      confirmed: results.length - superseded - failed.length,
      superseded,
    }),
  );

  // WAF is already correct, so do not fail the batch over a bookkeeping write;
  // the next sync retries it, and the tenant sees PENDING in the meantime.
  if (failed.length > 0) {
    console.error(
      JSON.stringify({
        msg: 'could not acknowledge every item',
        table: tableName,
        count: failed.length,
        error: String(failed[0].reason),
      }),
    );
  }
}
