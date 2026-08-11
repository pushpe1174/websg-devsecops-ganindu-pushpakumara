import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeAllowlist } from '../../src/lib/cidr.ts';
import { ValidationError } from '../../src/lib/errors.ts';
import { testConfig } from '../helpers/index.ts';

const normalize = (entries: string[]) => normalizeAllowlist(entries, testConfig.policy);

test('widens a bare IPv4 address to /32 and sorts the result', () => {
  assert.deepEqual(normalize(['203.0.113.9', '198.51.100.0/24']), ['198.51.100.0/24', '203.0.113.9/32']);
});

test('deduplicates equivalent entries', () => {
  assert.deepEqual(normalize(['203.0.113.9', '203.0.113.9/32']), ['203.0.113.9/32']);
});

test('canonicalises IPv6', () => {
  assert.deepEqual(normalize(['2001:0DB8:0000:0000:0000:0000:0000:0000/64']), ['2001:db8::/64']);
});

test('rejects malformed input', () => {
  for (const bad of ['not-an-ip', '203.0.113.9/', '203.0.113.9/33', '203.0.113.9/24/8', '']) {
    assert.throws(() => normalize([bad]), ValidationError, `expected rejection of ${bad}`);
  }
});

test('rejects private, loopback and link-local ranges', () => {
  for (const bad of ['10.0.0.0/24', '192.168.1.1', '172.16.0.0/24', '127.0.0.1', '169.254.1.1', '::1', 'fd00::/48']) {
    assert.throws(() => normalize([bad]), ValidationError, `expected rejection of ${bad}`);
  }
});

test('rejects ranges broader than policy', () => {
  assert.throws(() => normalize(['203.0.0.0/8']), ValidationError);
  assert.throws(() => normalize(['2001:db8::/32']), ValidationError);
});

test('rejects a CIDR with host bits set', () => {
  assert.throws(() => normalize(['203.0.113.9/24']), ValidationError);
});

test('rejects more entries than the configured maximum', () => {
  const many = Array.from({ length: testConfig.policy.maxEntries + 1 }, (_, i) => `203.0.113.${i}`);
  assert.throws(() => normalize(many), ValidationError);
});

test('reports every invalid entry at once', () => {
  try {
    normalize(['nope', '10.0.0.1', '203.0.113.1']);
    assert.fail('expected ValidationError');
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.reasons.length, 2);
  }
});
