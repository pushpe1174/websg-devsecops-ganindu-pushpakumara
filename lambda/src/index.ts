import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetIPSetCommand, UpdateIPSetCommand, WAFV2Client, type Scope } from '@aws-sdk/client-wafv2';

type Tenant = { ipSetId: string; ipSetName: string; ipSetScope: Scope };
type Allowlist = {
  ownerId: string;
  cidrs: string[];
  version: number;
  syncedVersion?: number;
  updatedAt?: string;
};

const env = {
  // The one allowlist table, partitioned by tenant id.
  tableName: process.env.TABLE_NAME ?? '',
  // Tenant -> its IPSet, written by Terraform. Onboarding a tenant is an apply,
  // never a code change.
  tenants: JSON.parse(process.env.TENANTS ?? '{}') as Record<string, Tenant>,
  // Ops/break-glass ranges added to every IPSet, so an empty partition can never
  // lock everyone out of the CMS.
  breakGlass: (process.env.BREAK_GLASS_CIDRS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  metricNamespace: process.env.METRIC_NAMESPACE ?? 'WebSG/Allowlist',
};

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const waf = new WAFV2Client({});

/**
 * Reconciles each tenant's IPSet from that tenant's partition of the allowlist
 * table: one partition, one IPSet. Agencies sharing a tenant share its
 * partition, so their ranges are simply the union of the items in it.
 *
 * The message is only a signal - state is rebuilt from the table - so retries,
 * redelivery and the scheduled sweep all converge on the same answer.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batch = parseBatch(event);
  const targets = Object.entries(env.tenants).filter(
    ([id]) => batch.tenants === 'all' || batch.tenants.has(id),
  );

  console.log(
    JSON.stringify({
      msg: 'sync triggered',
      records: event.Records?.length ?? 0,
      tenants: targets.map(([id]) => id),
    }),
  );

  const failed = new Set<string>();

  for (const [id, tenant] of targets) {
    try {
      const allowlists = await readAllowlists(id);
      reportOldestUnacknowledged(id, allowlists);

      const desired = [
        ...new Set([...env.breakGlass, ...allowlists.flatMap((item) => item.cidrs)]),
      ].sort();

      await reconcile(tenant, desired);
      await confirmApplied(id, allowlists);
    } catch (err) {
      // Keep going: one tenant's problem must not block every other tenant.
      failed.add(id);
      console.error(JSON.stringify({ msg: 'tenant sync failed', tenant: id, error: String(err) }));
    }
  }

  // Return only the messages belonging to tenants that failed, so a single bad
  // tenant does not push nine healthy ones toward the DLQ. Requires
  // ReportBatchItemFailures on the event source mapping - without it, an empty
  // response means "all succeeded" and the failures are silently dropped.
  const batchItemFailures = [...failed]
    .flatMap((id) => batch.messageIds.get(id) ?? [])
    .concat(failed.size > 0 ? batch.sweepMessageIds : [])
    .map((itemIdentifier) => ({ itemIdentifier }));

  if (batchItemFailures.length > 0) {
    console.error(
      JSON.stringify({
        msg: 'returning failed messages for retry',
        tenants: [...failed],
        messages: batchItemFailures.length,
      }),
    );
  }

  return { batchItemFailures };
}

type Batch = {
  /** Tenants this batch is about, or every tenant. */
  tenants: Set<string> | 'all';
  /** Tenant -> the message ids that asked for it. */
  messageIds: Map<string, string[]>;
  /** Messages that asked for a full sweep; they fail if any tenant fails. */
  sweepMessageIds: string[];
};

/**
 * Works out which tenants this batch is about, from the `tenantId` each message
 * carries - the API stamps it on a write, the scheduled sweep stamps it per
 * target. Anything else - a manual invoke, a body we cannot read, a tenant id we
 * do not recognise - is a full sweep: being slow beats silently skipping an
 * IPSet.
 */
function parseBatch(event: SQSEvent): Batch {
  const tenants = new Set<string>();
  const messageIds = new Map<string, string[]>();
  const sweepMessageIds: string[] = [];
  let sweep = false;

  for (const record of event.Records ?? []) {
    const tenantId = tenantOf(record);

    if (tenantId === undefined) {
      sweep = true;
      sweepMessageIds.push(record.messageId);
      continue;
    }

    tenants.add(tenantId);
    messageIds.set(tenantId, [...(messageIds.get(tenantId) ?? []), record.messageId]);
  }

  return {
    tenants: sweep || tenants.size === 0 ? 'all' : tenants,
    messageIds,
    sweepMessageIds,
  };
}

function tenantOf(record: SQSRecord): string | undefined {
  try {
    const { tenantId } = JSON.parse(record.body) as { tenantId?: string };
    return tenantId !== undefined && tenantId in env.tenants ? tenantId : undefined;
  } catch {
    return undefined;
  }
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
      // Optimistic lock. Per-tenant message grouping should mean there is never
      // a competing writer, so this is a belt-and-braces guard against a manual
      // console edit landing mid-update: the call fails, the message is
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

/**
 * Reads one tenant's allowlists. A Query on that tenant's partition, so the cost
 * is bounded by the tenant's member count rather than by the size of the table.
 */
async function readAllowlists(tenantId: string): Promise<Allowlist[]> {
  const allowlists: Allowlist[] = [];
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: env.tableName,
        KeyConditionExpression: 'tenantId = :tenantId',
        // `version` is a DynamoDB reserved word, hence the alias.
        ProjectionExpression: 'ownerId, cidrs, #v, syncedVersion, updatedAt',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':tenantId': tenantId },
        ExclusiveStartKey: startKey,
        // Strongly consistent: a default (eventually consistent) read can miss
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
        updatedAt: item.updatedAt === undefined ? undefined : String(item.updatedAt),
      });
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  return allowlists;
}

/**
 * Distinguishes slow from stuck. Reports how old this tenant's oldest
 * unacknowledged edit was at the moment the partition was read: a few seconds on
 * a healthy platform, growing sweep after sweep when something is wedged.
 *
 * Emitted before reconciling, so a tenant whose sync keeps failing still reports
 * - the number climbing is the whole signal. Embedded metric format, so it costs
 * a log line and needs no cloudwatch:PutMetricData.
 */
function reportOldestUnacknowledged(tenantId: string, items: Allowlist[]): void {
  const ages = items
    .filter((item) => item.syncedVersion !== item.version && item.updatedAt)
    .map((item) => Date.now() - Date.parse(item.updatedAt!))
    .filter((age) => Number.isFinite(age));

  // Zero when nothing is outstanding, so the alarm always has a datapoint and
  // recovery is visible rather than inferred from missing data.
  const oldest = ages.length === 0 ? 0 : Math.max(...ages);

  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: env.metricNamespace,
            Dimensions: [['Tenant']],
            Metrics: [{ Name: 'OldestUnacknowledgedAgeSeconds', Unit: 'Seconds' }],
          },
        ],
      },
      msg: 'sync lag',
      Tenant: tenantId,
      OldestUnacknowledgedAgeSeconds: Math.max(0, Math.round(oldest / 1000)),
      pending: ages.length,
    }),
  );
}

/**
 * Records which version is live in WAF, so the API can report APPLIED instead
 * of guessing. Only unacknowledged items are written, so a routine sync of an
 * unchanged platform costs no writes.
 *
 * The conditional write keeps this honest: if the item was saved again between
 * the read and here, that newer version was never in the IPSet, so the update
 * is rejected and it correctly stays PENDING until its own message arrives.
 */
async function confirmApplied(tenantId: string, items: Allowlist[]): Promise<void> {
  const pending = items.filter((item) => item.syncedVersion !== item.version);
  if (pending.length === 0) return;

  const syncedAt = new Date().toISOString();

  const results = await Promise.allSettled(
    pending.map((item) =>
      ddb.send(
        new UpdateCommand({
          TableName: env.tableName,
          Key: { tenantId, ownerId: item.ownerId },
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
      tenant: tenantId,
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
        tenant: tenantId,
        count: failed.length,
        error: String(failed[0].reason),
      }),
    );
  }
}
