import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetIPSetCommand, UpdateIPSetCommand, WAFV2Client } from '@aws-sdk/client-wafv2';
import type { SQSEvent } from 'aws-lambda';

// As Terraform renders it: one table and one IPSet per tenant.
const TENANTS = {
  'tenant-a': {
    tableName: 'websg-cms-allowlist-tenant-a',
    ipSetId: 'ipset-a',
    ipSetName: 'websg-cms-allowlist-tenant-a',
    ipSetScope: 'REGIONAL',
  },
  'tenant-b': {
    tableName: 'websg-cms-allowlist-tenant-b',
    ipSetId: 'ipset-b',
    ipSetName: 'websg-cms-allowlist-tenant-b',
    ipSetScope: 'REGIONAL',
  },
};

process.env.TENANTS = JSON.stringify(TENANTS);
process.env.BREAK_GLASS_CIDRS = '192.0.2.0/24';

const { handler } = await import('../src/index.ts');

// No parseable body: the worker falls back to a full sweep, which is what a
// drift check or a manual invoke produces.
const event = { Records: [{}] } as SQSEvent;

/** A message as the Pipe delivers it: one stream record, carrying its table. */
const editIn = (tenant: keyof typeof TENANTS) =>
  ({
    Records: [
      {
        body: JSON.stringify({
          eventSourceARN: `arn:aws:dynamodb:ap-southeast-1:1234:table/${TENANTS[tenant].tableName}/stream/2026`,
          dynamodb: { Keys: { ownerId: { S: 'user-a' } } },
        }),
      },
    ],
  }) as SQSEvent;

type Item = { ownerId: string; cidrs: string[]; version: number; syncedVersion?: number };

const item = (ownerId: string, cidrs: string[], version = 1, syncedVersion?: number): Item => ({
  ownerId,
  cidrs,
  version,
  syncedVersion,
});

const ddbCalls: (ScanCommand | UpdateCommand)[] = [];

/** Stubs the SDK transport so the handler's real logic runs unchanged. */
function stubAws(
  tables: Record<string, Item[]>,
  options: { addresses?: Record<string, string[]>; failIpSetIds?: string[] } = {},
) {
  ddbCalls.length = 0;

  mock.method(DynamoDBDocumentClient.prototype, 'send', async (command: ScanCommand) => {
    ddbCalls.push(command);
    if (command instanceof ScanCommand) {
      return { Items: tables[command.input.TableName!] ?? [] };
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
    c.input.TableName,
    c.input.Key?.ownerId,
  ]);

const tableA = TENANTS['tenant-a'].tableName;
const tableB = TENANTS['tenant-b'].tableName;

test.afterEach(() => mock.restoreAll());

test('each tenant gets its own IPSet, built from its own table', async () => {
  const calls = stubAws({
    [tableA]: [item('user-a', ['203.0.113.0/24'])],
    [tableB]: [item('user-b', ['198.51.100.0/24'])],
  });
  await handler(event);

  const updates = updatesOf(calls);
  assert.equal(updates.length, 2);

  const byId = new Map(updates.map((u) => [u.input.Id, u.input.Addresses]));
  // Tenant A's range must never appear in tenant B's IPSet.
  assert.deepEqual(byId.get('ipset-a'), ['192.0.2.0/24', '203.0.113.0/24']);
  assert.deepEqual(byId.get('ipset-b'), ['192.0.2.0/24', '198.51.100.0/24']);
});

test('agencies sharing a tenant table get the union in one IPSet', async () => {
  const calls = stubAws({
    [tableA]: [item('user-c', ['203.0.113.0/24']), item('user-d', ['198.51.100.0/24'])],
  });
  await handler(event);

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
    [tableA]: [item('user-a', ['203.0.113.0/24'])],
    [tableB]: [item('user-b', ['198.51.100.0/24'])],
  });
  await handler(event);

  for (const update of updatesOf(calls)) {
    assert.equal(update.input.LockToken, `lock-${update.input.Id}`);
  }
});

test('reverts a manual edit made outside the application', async () => {
  // Someone added a range in the console. The rebuild removes it.
  const calls = stubAws(
    { [tableA]: [item('user-a', ['203.0.113.0/24'])] },
    { addresses: { 'ipset-a': ['203.0.113.0/24', '192.0.2.0/24', '10.10.10.10/32'] } },
  );
  await handler(event);

  assert.deepEqual(updatesOf(calls)[0].input.Addresses, ['192.0.2.0/24', '203.0.113.0/24']);
});

test('skips the update when an IPSet already matches', async () => {
  const calls = stubAws(
    { [tableA]: [item('user-a', ['203.0.113.0/24'], 1, 1)] },
    { addresses: { 'ipset-a': ['192.0.2.0/24', '203.0.113.0/24'] } },
  );
  await handler(event);

  assert.equal(updatesOf(calls).filter((u) => u.input.Id === 'ipset-a').length, 0);
});

test('one tenant failing does not block the others', async () => {
  const calls = stubAws(
    {
      [tableA]: [item('user-a', ['203.0.113.0/24'])],
      [tableB]: [item('user-b', ['198.51.100.0/24'])],
    },
    { failIpSetIds: ['ipset-a'] },
  );

  await assert.rejects(handler(event), /failed to reconcile 1 tenant/);

  // B was still applied and acknowledged; A stays PENDING and the batch retries.
  assert.deepEqual(
    updatesOf(calls).map((u) => u.input.Id),
    ['ipset-a', 'ipset-b'],
  );
  assert.deepEqual(acknowledged(), [[tableB, 'user-b']]);
});

test('acknowledges the items whose IPSet was reconciled', async () => {
  stubAws({ [tableA]: [item('user-a', ['203.0.113.0/24'], 4)] });
  await handler(event);

  assert.deepEqual(acknowledged(), [[tableA, 'user-a']]);
});

test('does not rewrite items already acknowledged at their latest version', async () => {
  stubAws({
    [tableA]: [item('user-a', ['203.0.113.0/24'], 4, 4)],
    [tableB]: [item('user-b', ['198.51.100.0/24'], 2)],
  });
  await handler(event);

  assert.deepEqual(acknowledged(), [[tableB, 'user-b']]);
});

test('an edit touches only the IPSet of the table it came from', async () => {
  const calls = stubAws({
    [tableA]: [item('user-a', ['203.0.113.0/24'])],
    [tableB]: [item('user-b', ['198.51.100.0/24'])],
  });

  await handler(editIn('tenant-a'));

  // Tenant B's IPSet is not even read, so the two reconcile in parallel without
  // redoing each other's work.
  assert.deepEqual(
    updatesOf(calls).map((u) => u.input.Id),
    ['ipset-a'],
  );
  assert.deepEqual(acknowledged(), [[tableA, 'user-a']]);
});

test('an edit by one agency of a shared table still applies the union', async () => {
  const calls = stubAws({
    [tableA]: [item('user-c', ['203.0.113.0/24']), item('user-d', ['198.51.100.0/24'])],
  });

  await handler(editIn('tenant-a'));

  // D did not change, but its ranges must survive C's edit.
  assert.deepEqual(updatesOf(calls)[0].input.Addresses, [
    '192.0.2.0/24',
    '198.51.100.0/24',
    '203.0.113.0/24',
  ]);
});

test('the drift check sweeps every IPSet', async () => {
  const calls = stubAws({
    [tableA]: [item('user-a', ['203.0.113.0/24'])],
    [tableB]: [item('user-b', ['198.51.100.0/24'])],
  });

  const driftCheck = {
    Records: [{ body: JSON.stringify({ source: 'drift-check', time: '2026-08-11T09:00:00Z' }) }],
  } as SQSEvent;
  await handler(driftCheck);

  assert.deepEqual(
    updatesOf(calls)
      .map((u) => u.input.Id)
      .sort(),
    ['ipset-a', 'ipset-b'],
  );
});

test('reads each allowlist table with a strongly consistent scan', async () => {
  stubAws({ [tableA]: [item('user-a', ['203.0.113.0/24'])] });
  await handler(event);

  const scan = ddbCalls.find(
    (c) => c instanceof ScanCommand && c.input.TableName === tableA,
  ) as ScanCommand;
  assert.equal(scan.input.ConsistentRead, true);
});
