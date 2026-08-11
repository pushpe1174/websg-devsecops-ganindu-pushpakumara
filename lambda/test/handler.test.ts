import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetIPSetCommand, UpdateIPSetCommand, WAFV2Client } from '@aws-sdk/client-wafv2';
import type { SQSEvent } from 'aws-lambda';

process.env.TABLE_NAME = 'allowlist-table';
process.env.CONFIG_TABLE_NAME = 'config-table';
process.env.BREAK_GLASS_CIDRS = '192.0.2.0/24';

const { handler } = await import('../src/index.ts');

// No parseable body: the worker falls back to a full sweep, which is what a
// drift check or a manual invoke produces.
const event = { Records: [{}] } as SQSEvent;

/** A message as the Pipe delivers it: one stream record, one tenant. */
const editBy = (...tenantIds: string[]) =>
  ({
    Records: tenantIds.map((tenantId) => ({
      body: JSON.stringify({ dynamodb: { Keys: { tenantId: { S: tenantId } } } }),
    })),
  }) as SQSEvent;

type ConfigItem = { tenantId: string; ipSetId: string; ipSetName: string; ipSetScope?: string };
type AllowlistItem = { tenantId: string; cidrs: string[]; version: number; syncedVersion?: number };

const config = (tenantId: string, ipSetId: string): ConfigItem => ({
  tenantId,
  ipSetId,
  ipSetName: `cms-${ipSetId}`,
  ipSetScope: 'REGIONAL',
});

const allowlist = (
  tenantId: string,
  cidrs: string[],
  version = 1,
  syncedVersion?: number,
): AllowlistItem => ({ tenantId, cidrs, version, syncedVersion });

const ddbCalls: unknown[] = [];

/** Stubs the SDK transport so the handler's real logic runs unchanged. */
function stubAws(
  configs: ConfigItem[],
  allowlists: AllowlistItem[],
  options: { addresses?: Record<string, string[]>; failIpSetIds?: string[] } = {},
) {
  ddbCalls.length = 0;

  mock.method(DynamoDBDocumentClient.prototype, 'send', async (command: unknown) => {
    ddbCalls.push(command);
    if (command instanceof ScanCommand) {
      return { Items: command.input.TableName === 'config-table' ? configs : allowlists };
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
    if (
      command instanceof UpdateIPSetCommand &&
      options.failIpSetIds?.includes(command.input.Id!)
    ) {
      throw new Error(`WAFOptimisticLockException for ${command.input.Id}`);
    }
    return {};
  });

  return wafCalls;
}

const updatesOf = (calls: unknown[]) =>
  calls.filter((c) => c instanceof UpdateIPSetCommand) as UpdateIPSetCommand[];

const acknowledged = () =>
  (ddbCalls.filter((c) => c instanceof UpdateCommand) as UpdateCommand[]).map(
    (c) => c.input.Key?.tenantId,
  );

test.afterEach(() => mock.restoreAll());

test('gives each tenant its own IPSet when they are mapped separately', async () => {
  const calls = stubAws(
    [config('agency-a', 'ipset-a'), config('agency-b', 'ipset-b')],
    [allowlist('agency-a', ['203.0.113.0/24']), allowlist('agency-b', ['198.51.100.0/24'])],
  );
  await handler(event);

  const updates = updatesOf(calls);
  assert.equal(updates.length, 2);

  const byId = new Map(updates.map((u) => [u.input.Id, u.input.Addresses]));
  // Tenant A's range must never appear in tenant B's IPSet.
  assert.deepEqual(byId.get('ipset-a'), ['192.0.2.0/24', '203.0.113.0/24']);
  assert.deepEqual(byId.get('ipset-b'), ['192.0.2.0/24', '198.51.100.0/24']);
});

test('merges tenants that share one IPSet', async () => {
  const calls = stubAws(
    [config('agency-a', 'shared'), config('agency-b', 'shared')],
    [allowlist('agency-a', ['203.0.113.0/24']), allowlist('agency-b', ['198.51.100.0/24'])],
  );
  await handler(event);

  const updates = updatesOf(calls);
  assert.equal(updates.length, 1, 'a shared IPSet is reconciled once, not once per tenant');
  assert.deepEqual(updates[0].input.Addresses, [
    '192.0.2.0/24',
    '198.51.100.0/24',
    '203.0.113.0/24',
  ]);
});

test('uses the lock token belonging to each IPSet', async () => {
  const calls = stubAws(
    [config('agency-a', 'ipset-a'), config('agency-b', 'ipset-b')],
    [allowlist('agency-a', ['203.0.113.0/24']), allowlist('agency-b', ['198.51.100.0/24'])],
  );
  await handler(event);

  for (const update of updatesOf(calls)) {
    assert.equal(update.input.LockToken, `lock-${update.input.Id}`);
  }
});

test('reverts a manual edit made outside the application', async () => {
  // Someone added a range in the console. The rebuild removes it.
  const calls = stubAws([config('agency-a', 'ipset-a')], [allowlist('agency-a', ['203.0.113.0/24'])], {
    addresses: { 'ipset-a': ['203.0.113.0/24', '192.0.2.0/24', '10.10.10.10/32'] },
  });
  await handler(event);

  assert.deepEqual(updatesOf(calls)[0].input.Addresses, ['192.0.2.0/24', '203.0.113.0/24']);
});

test('skips the update when an IPSet already matches', async () => {
  const calls = stubAws([config('agency-a', 'ipset-a')], [allowlist('agency-a', ['203.0.113.0/24'], 1, 1)], {
    addresses: { 'ipset-a': ['192.0.2.0/24', '203.0.113.0/24'] },
  });
  await handler(event);

  assert.equal(updatesOf(calls).length, 0);
});

test('one tenant failing does not block the others', async () => {
  const calls = stubAws(
    [config('agency-a', 'ipset-a'), config('agency-b', 'ipset-b')],
    [allowlist('agency-a', ['203.0.113.0/24']), allowlist('agency-b', ['198.51.100.0/24'])],
    { failIpSetIds: ['ipset-a'] },
  );

  await assert.rejects(handler(event), /failed to reconcile 1 IPSet/);

  // B was still applied and acknowledged; A stays PENDING and the batch retries.
  assert.deepEqual(
    updatesOf(calls).map((u) => u.input.Id),
    ['ipset-a', 'ipset-b'],
  );
  assert.deepEqual(acknowledged(), ['agency-b']);
});

test('acknowledges only tenants whose IPSet was reconciled', async () => {
  stubAws([config('agency-a', 'ipset-a')], [allowlist('agency-a', ['203.0.113.0/24'], 4)]);
  await handler(event);

  assert.deepEqual(acknowledged(), ['agency-a']);
});

test('does not rewrite tenants already acknowledged at their latest version', async () => {
  stubAws(
    [config('agency-a', 'ipset-a'), config('agency-b', 'ipset-b')],
    [allowlist('agency-a', ['203.0.113.0/24'], 4, 4), allowlist('agency-b', ['198.51.100.0/24'], 2)],
  );
  await handler(event);

  assert.deepEqual(acknowledged(), ['agency-b']);
});

test('leaves an unmapped tenant PENDING instead of applying it somewhere', async () => {
  const calls = stubAws(
    [config('agency-a', 'ipset-a')],
    [allowlist('agency-a', ['203.0.113.0/24']), allowlist('agency-unmapped', ['198.51.100.0/24'])],
  );
  await handler(event);

  // The unmapped tenant's ranges must not leak into another tenant's IPSet.
  assert.deepEqual(updatesOf(calls)[0].input.Addresses, ['192.0.2.0/24', '203.0.113.0/24']);
  assert.deepEqual(acknowledged(), ['agency-a']);
});

test('a tenant edit touches only that tenant\'s IPSet', async () => {
  const calls = stubAws(
    [config('agency-c', 'ipset-c'), config('agency-d', 'ipset-d')],
    [allowlist('agency-c', ['203.0.113.0/24']), allowlist('agency-d', ['198.51.100.0/24'])],
  );

  await handler(editBy('agency-c'));

  // Tenant D's IPSet is not even read, so C and D reconcile in parallel without
  // redoing each other's work.
  assert.deepEqual(
    updatesOf(calls).map((u) => u.input.Id),
    ['ipset-c'],
  );
  assert.deepEqual(acknowledged(), ['agency-c']);
});

test('an edit by one tenant of a shared IPSet still applies the union', async () => {
  const calls = stubAws(
    [config('agency-a', 'shared'), config('agency-b', 'shared')],
    [allowlist('agency-a', ['203.0.113.0/24']), allowlist('agency-b', ['198.51.100.0/24'])],
  );

  await handler(editBy('agency-a'));

  // B did not change, but its ranges must survive A's edit.
  assert.deepEqual(updatesOf(calls)[0].input.Addresses, [
    '192.0.2.0/24',
    '198.51.100.0/24',
    '203.0.113.0/24',
  ]);
});

test('the drift check sweeps every IPSet', async () => {
  const calls = stubAws(
    [config('agency-c', 'ipset-c'), config('agency-d', 'ipset-d')],
    [allowlist('agency-c', ['203.0.113.0/24']), allowlist('agency-d', ['198.51.100.0/24'])],
  );

  const driftCheck = {
    Records: [{ body: JSON.stringify({ source: 'drift-check', time: '2026-08-11T09:00:00Z' }) }],
  } as SQSEvent;
  await handler(driftCheck);

  assert.deepEqual(
    updatesOf(calls)
      .map((u) => u.input.Id)
      .sort(),
    ['ipset-c', 'ipset-d'],
  );
});

test('reads the allowlist table with a strongly consistent scan', async () => {
  stubAws([config('agency-a', 'ipset-a')], [allowlist('agency-a', ['203.0.113.0/24'])]);
  await handler(event);

  const scan = ddbCalls.find(
    (c) => c instanceof ScanCommand && c.input.TableName === 'allowlist-table',
  ) as ScanCommand;
  assert.equal(scan.input.ConsistentRead, true);
});
