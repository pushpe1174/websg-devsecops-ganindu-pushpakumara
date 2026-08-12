import { isIPv4, isIPv6 } from 'node:net';
import type { Config } from '../config.ts';
import { validationError } from './errors.ts';

type Policy = Config['policy'];

/**
 * Canonicalises tenant entries into WAF IPSet form: a bare IPv4 address (widened
 * to /32) or an explicit CIDR. Rejects malformed input, non-routable ranges,
 * ranges broader than policy, and host bits set (WAF wants the network address).
 *
 * IPv6 is rejected because WAF IPSets are single-family and these are IPV4 - a
 * v6 range would store, report PENDING and never go live. Supporting it means a
 * second IPSet per tenant, family routing in the worker, and both in the WebACL.
 */
export function normalizeAllowlist(entries: string[], policy: Policy): string[] {
  if (entries.length > policy.maxEntries) {
    throw validationError([`At most ${policy.maxEntries} entries are allowed`]);
  }

  const reasons: string[] = [];
  const seen = new Set<string>();

  for (const raw of entries) {
    try {
      seen.add(normalizeEntry(raw.trim(), policy));
    } catch (err) {
      reasons.push(`${JSON.stringify(raw)}: ${(err as Error).message}`);
    }
  }

  if (reasons.length > 0) throw validationError(reasons);
  return [...seen].sort();
}

function normalizeEntry(entry: string, policy: Policy): string {
  const [address, prefixPart, ...rest] = entry.split('/');
  if (rest.length > 0) throw new Error('malformed CIDR');

  if (!isIPv4(address)) {
    // Separate message so a caller can tell a typo from an unsupported family.
    if (isIPv6(address)) throw new Error('IPv6 is not supported, use an IPv4 address or CIDR');
    throw new Error('not a valid IPv4 address');
  }

  const prefix = prefixPart === undefined ? 32 : Number(prefixPart);

  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error('prefix length out of range');
  }
  if (prefix < policy.minPrefixV4) {
    throw new Error(`range too broad, use /${policy.minPrefixV4} or narrower`);
  }

  const bytes = address.split('.').map(Number);
  if (!isPubliclyRoutable(bytes)) {
    throw new Error('private, loopback, link-local or reserved ranges are not allowed');
  }
  if (hasHostBits(bytes, prefix)) {
    throw new Error(`host bits set, use the network address for /${prefix}`);
  }

  return `${address}/${prefix}`;
}

function hasHostBits(bytes: number[], prefix: number): boolean {
  return bytes.some((byte, i) => {
    const bitsBefore = i * 8;
    if (prefix >= bitsBefore + 8) return false;
    const keep = Math.max(0, prefix - bitsBefore);
    return (byte & (0xff >> keep)) !== 0;
  });
}

function isPubliclyRoutable([a, b]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-network, RFC1918, loopback, multicast/reserved
  if (a === 100 && b >= 64 && b < 128) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b < 32) return false; // RFC1918
  if (a === 192 && b === 168) return false; // RFC1918
  return true;
}
