import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetIPSetCommand, UpdateIPSetCommand, WAFV2Client } from '@aws-sdk/client-wafv2';
import type { SQSEvent, SQSRecord } from 'aws-lambda';

// As Terraform renders it: one IPSet per tenant, one table for all of them.
const TENANTS = {
  'tenant-a': {
    ipSetId: 'ipset-a',
    ipSetName: 'websg-cms-allowlist-tenant-a',
    ipSetScope: 'REGIONAL',
  },
  'tenant-b': {
    ipSetId: 'ipset-b',
    ipSetName: 'websg-cms-allowlist-tenant-b',
    ipSetScope: 'REGIONAL',
  },
};

const TABLE = 'websg-cms-allowlist';

process.env.TABLE_NAME = TABLE;
process.env.TENANTS = JSON.stringify(TENANTS);
process.env.BREAK_GLASS_CIDRS = '192.0.2.0/24';
process.env.METRIC_NAMESPACE = 'WebSG/Test';

const { handler } = await import('../src/index.ts');

let nextMessageId = 0;
const record = (body?: object): SQSRecord =>
  ({
    messageId: `msg-${++nextMessageId}`,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as SQSRecord;

// No parseable body: the worker falls back to a full sweep, which is what a
// manual invoke produces.
const anyEvent = (): SQSEvent => ({ Records: [record()] }) as SQSEvent;

/** A message as the API sends it after a write. */
const editIn = (tenantId: keyof typeof TENANTS, ownerId = 'user-a'): SQSEvent =>
  ({ Records: [record({ source: 'api', tenantId, ownerId, version: 1 })] }) as SQSEvent;

type Item = {
  ownerId: string;
  cidrs: string[];
  version: number;
  syncedVersion?: number;
  updatedAt?: string;
};

const item = (ownerId: string, cidrs: string[], version = 1, syncedVersion?: number): Item => ({
  ownerId,
  cidrs,
  version,
  syncedVersion,
  updatedAt: new Date().toISOString(),
});

const ddbCalls: (QueryCommand | UpdateCommand)[] = [];
const logLines: string[] = [];

/** Stubs the SDK transport so the handler's real logic runs unchanged. */
function stubAws(
  partitions: Record<string, Item[]>,
  options: { addresses?: Record<string, string[]>; failIpSetIds?: string[] } = {},
) {
  ddbCalls.length = 0;
  logLines.length = 0;

  mock.method(console, 'log', (line: string) => logLines.push(line));
  mock.method(console, 'error', () => {});

  mock.method(DynamoDBDocumentClient.prototype, 'send', async (command: QueryCommand) => {
    ddbCalls.push(command);
    if (command instanceof QueryCommand) {
      const tenantId = command.input.ExpressionAttributeValues?.[':tenantId'] as string;
      return { Items: partitions[tenantId] ?? [] };
    }
    return {};
  });

  const wafCalls: unknown[] = [];
  mock.method(WAFV2Client.prototype, 'send', async (command: unknown) => {
    wafCalls.push(command);

    if (command instanceof GetIPSetCommand) {
      return {
        IPSet: { Addresses: options.addresses?.[command.input.Id!] ?? [] },
        LockToken: `lock-${command.input.Id}`,
      };
    }
    if (command instanceof UpdateIPSetCommand && options.failIpSetIds?.includes(command.input.Id!)) {
      throw new Error(`WAFOptimisticLockException for ${command.input.Id}`);
    }
    return {};
  });

  return wafCalls;
}

const updatesOf = (calls: unknown[]) =>
  calls.filter((c) => c instanceof UpdateIPSetCommand) as UpdateIPSetCommand[];

const acknowledged = () =>
  (ddbCalls.filter((c) => c instanceof UpdateCommand) as UpdateCommand[]).map((c) => [
    c.input.Key?.tenantId,
    c.input.Key?.ownerId,
  ]);

const metrics = () =>
  logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry._aws !== undefined);

test.afterEach(() => mock.restoreAll());

test('each tenant gets its own IPSet, built from its own partition', async () => {
  const calls = stubAws({
    'tenant-a': [item('user-a', ['203.0.113.0/24'])],
    'tenant-b': [item('user-b', ['198.51.100.0/24'])],
  });
  await handler(anyEvent());

  const updates = updatesOf(calls);
  assert.equal(updates.length, 2);

  const byId = new Map(updates.map((u) => [u.input.Id, u.input.Addresses]));
  // Tenant A's range must never appear in tenant B's IPSet.
  assert.deepEqual(byId.get('ipset-a'), ['192.0.2.0/24', '203.0.113.0/24']);
  assert.deepEqual(byId.get('ipset-b'), ['192.0.2.0/24', '198.51.100.0/24']);
});

test('agencies sharing a tenant get the union in one IPSet', async () => {
  const calls = stubAws({
    'tenant-a': [item('user-c', ['203.0.113.0/24']), item('user-d', ['198.51.100.0/24'])],
  });
  await handler(anyEvent());

  const updates = updatesOf(calls).filter((u) => u.input.Id === 'ipset-a');
  assert.equal(updates.length, 1, 'a shared IPSet is reconciled once, not once per agency');
  assert.deepEqual(updates[0].input.Addresses, [
    '192.0.2.0/24',
    '198.51.100.0/24',
    '203.0.113.0/24',
  ]);
});

test('uses the lock token belonging to each IPSet', async () => {
  const calls = stubAws({
    'tenant-a': [item('user-a', ['203.0.113.0/24'])],
    'tenant-b': [item('user-b', ['198.51.100.0/24'])],
  });
  await handler(anyEvent());

  for (const update of updatesOf(calls)) {
    assert.equal(update.input.LockToken, `lock-${update.input.Id}`);
  }
});

test('reverts a manual edit made outside the application', async () => {
  // Someone added a range in the console. The rebuild removes it.
  const calls = stubAws(
    { 'tenant-a': [item('user-a', ['203.0.113.0/24'])] },
    { addresses: { 'ipset-a': ['203.0.113.0/24', '192.0.2.0/24', '10.10.10.10/32'] } },
  );
  await handler(anyEvent());

  assert.deepEqual(updatesOf(calls)[0].input.Addresses, ['192.0.2.0/24', '203.0.113.0/24']);
});

test('skips the update when an IPSet already matches', async () => {
  const calls = stubAws(
    { 'tenant-a': [item('user-a', ['203.0.113.0/24'], 1, 1)] },
    { addresses: { 'ipset-a': ['192.0.2.0/24', '203.0.113.0/24'] } },
  );
  await handler(anyEvent());

  assert.equal(updatesOf(calls).filter((u) => u.input.Id === 'ipset-a').length, 0);
});

test('one tenant failing does not block the others', async () => {
  const calls = stubAws(
    {
      'tenant-a': [item('user-a', ['203.0.113.0/24'])],
      'tenant-b': [item('user-b', ['198.51.100.0/24'])],
    },
    { failIpSetIds: ['ipset-a'] },
  );

  await handler(anyEvent());

  // B was still applied and acknowledged; A stays PENDING and is retried.
  assert.deepEqual(
    updatesOf(calls).map((u) => u.input.Id),
    ['ipset-a', 'ipset-b'],
  );
  assert.deepEqual(acknowledged(), [['tenant-b', 'user-b']]);
});

test('returns only the failed tenant’s messages, not the whole batch', async () => {
  stubAws(
    {
      'tenant-a': [item('user-a', ['203.0.113.0/24'])],
      'tenant-b': [item('user-b', ['198.51.100.0/24'])],
    },
    { failIpSetIds: ['ipset-a'] },
  );

  const a = record({ tenantId: 'tenant-a', ownerId: 'user-a', version: 1 });
  const b = record({ tenantId: 'tenant-b', ownerId: 'user-b', version: 1 });
  const response = await handler({ Records: [a, b] } as SQSEvent);

  // Healthy tenant B's message is not returned, so it is deleted from the queue
  // rather than redelivered and ticked toward the DLQ threshold.
  assert.deepEqual(response.batchItemFailures, [{ itemIdentifier: a.messageId }]);
});

test('a healthy batch reports no failures', async () => {
  stubAws({ 'tenant-a': [item('user-a', ['203.0.113.0/24'])] });

  const response = await handler(editIn('tenant-a'));
  assert.deepEqual(response.batchItemFailures, []);
});

test('a sweep message is retried when any tenant in the sweep fails', async () => {
  stubAws(
    {
      'tenant-a': [item('user-a', ['203.0.113.0/24'])],
      'tenant-b': [item('user-b', ['198.51.100.0/24'])],
    },
    { failIpSetIds: ['ipset-a'] },
  );

  const sweep = record();
  const response = await handler({ Records: [sweep] } as SQSEvent);

  assert.deepEqual(response.batchItemFailures, [{ itemIdentifier: sweep.messageId }]);
});

test('acknowledges the items whose IPSet was reconciled', async () => {
  stubAws({ 'tenant-a': [item('user-a', ['203.0.113.0/24'], 4)] });
  await handler(anyEvent());

  assert.deepEqual(acknowledged(), [['tenant-a', 'user-a']]);
});

test('does not rewrite items already acknowledged at their latest version', async () => {
  stubAws({
    'tenant-a': [item('user-a', ['203.0.113.0/24'], 4, 4)],
    'tenant-b': [item('user-b', ['198.51.100.0/24'], 2)],
  });
  await handler(anyEvent());

  assert.deepEqual(acknowledged(), [['tenant-b', 'user-b']]);
});

test('an edit touches only the IPSet of the tenant it came from', async () => {
  const calls = stubAws({
    'tenant-a': [item('user-a', ['203.0.113.0/24'])],
    'tenant-b': [item('user-b', ['198.51.100.0/24'])],
  });

  await handler(editIn('tenant-a'));

  // Tenant B's IPSet is not even read, so the two reconcile in parallel without
  // redoing each other's work.
  assert.deepEqual(
    updatesOf(calls).map((u) => u.input.Id),
    ['ipset-a'],
  );
  assert.deepEqual(acknowledged(), [['tenant-a', 'user-a']]);
});

test('an edit by one agency of a shared tenant still applies the union', async () => {
  const calls = stubAws({
    'tenant-a': [item('user-c', ['203.0.113.0/24']), item('user-d', ['198.51.100.0/24'])],
  });

  await handler(editIn('tenant-a', 'user-c'));

  // D did not change, but its ranges must survive C's edit.
  assert.deepEqual(updatesOf(calls)[0].input.Addresses, [
    '192.0.2.0/24',
    '198.51.100.0/24',
    '203.0.113.0/24',
  ]);
});

test('an unknown tenant id falls back to a full sweep rather than skipping', async () => {
  const calls = stubAws({
    'tenant-a': [item('user-a', ['203.0.113.0/24'])],
    'tenant-b': [item('user-b', ['198.51.100.0/24'])],
  });

  await handler({ Records: [record({ tenantId: 'tenant-decommissioned' })] } as SQSEvent);

  assert.deepEqual(
    updatesOf(calls)
      .map((u) => u.input.Id)
      .sort(),
    ['ipset-a', 'ipset-b'],
  );
});

test('the drift check sweeps every IPSet it is told about', async () => {
  const calls = stubAws({
    'tenant-a': [item('user-a', ['203.0.113.0/24'])],
    'tenant-b': [item('user-b', ['198.51.100.0/24'])],
  });

  // One message per tenant, as the schedule now emits them.
  await handler({
    Records: [
      record({ source: 'drift-check', tenantId: 'tenant-a', time: '2026-08-11T09:00:00Z' }),
      record({ source: 'drift-check', tenantId: 'tenant-b', time: '2026-08-11T09:00:00Z' }),
    ],
  } as SQSEvent);

  assert.deepEqual(
    updatesOf(calls)
      .map((u) => u.input.Id)
      .sort(),
    ['ipset-a', 'ipset-b'],
  );
});

test('queries one partition per tenant, strongly consistent, instead of scanning', async () => {
  stubAws({ 'tenant-a': [item('user-a', ['203.0.113.0/24'])] });
  await handler(editIn('tenant-a'));

  const queries = ddbCalls.filter((c) => c instanceof QueryCommand) as QueryCommand[];
  assert.equal(queries.length, 1);
  assert.equal(queries[0].input.TableName, TABLE);
  assert.equal(queries[0].input.KeyConditionExpression, 'tenantId = :tenantId');
  assert.equal(queries[0].input.ExpressionAttributeValues?.[':tenantId'], 'tenant-a');
  assert.equal(queries[0].input.ConsistentRead, true);
});

test('reports zero sync lag when every item is acknowledged', async () => {
  stubAws({ 'tenant-a': [item('user-a', ['203.0.113.0/24'], 3, 3)] });
  await handler(editIn('tenant-a'));

  const [metric] = metrics();
  assert.equal(metric.Tenant, 'tenant-a');
  assert.equal(metric.OldestUnacknowledgedAgeSeconds, 0);
  assert.equal(metric.pending, 0);
});

test('reports the age of the oldest unacknowledged edit', async () => {
  const stale = {
    ...item('user-a', ['203.0.113.0/24'], 2),
    updatedAt: new Date(Date.now() - 600_000).toISOString(),
  };
  const recent = {
    ...item('user-b', ['198.51.100.0/24'], 2),
    updatedAt: new Date(Date.now() - 5_000).toISOString(),
  };
  stubAws({ 'tenant-a': [recent, stale] });

  await handler(editIn('tenant-a'));

  const [metric] = metrics();
  // The oldest, not the newest: a stuck item is what the alarm is looking for.
  assert.equal(metric.OldestUnacknowledgedAgeSeconds, 600);
  assert.equal(metric.pending, 2);
});

test('still reports sync lag for a tenant whose reconcile fails', async () => {
  stubAws(
    {
      'tenant-a': [
        {
          ...item('user-a', ['203.0.113.0/24'], 2),
          updatedAt: new Date(Date.now() - 900_000).toISOString(),
        },
      ],
    },
    { failIpSetIds: ['ipset-a'] },
  );

  await handler(editIn('tenant-a'));

  // Without this the stuck alarm would go blind exactly when it is needed.
  const [metric] = metrics();
  assert.equal(metric.OldestUnacknowledgedAgeSeconds, 900);
});
