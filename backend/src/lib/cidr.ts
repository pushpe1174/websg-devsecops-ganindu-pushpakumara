import { isIPv4, isIPv6 } from 'node:net';
import type { Config } from '../config/index.ts';
import { ValidationError } from './errors.ts';

type Policy = Config['policy'];

/**
 * Validates and canonicalises tenant-submitted entries into WAF IPSet form.
 * Accepts a bare IPv4 address (widened to /32) or an explicit IPv4 CIDR.
 * Rejects: malformed input, non-routable ranges, ranges broader than policy,
 * and CIDRs whose host bits are set (WAF requires the network address).
 *
 * IPv6 is rejected. WAF IPSets are single-family and the ones this platform
 * provisions are IPV4, so accepting a v6 range here would store something the
 * infrastructure cannot hold - the address would be saved, reported PENDING, and
 * never go live. Supporting it properly means a second IPSet per tenant, family
 * routing in the sync worker, and both sets referenced from the CMS WebACL.
 */
export function normalizeAllowlist(entries: string[], policy: Policy): string[] {
  if (entries.length > policy.maxEntries) {
    throw new ValidationError([`At most ${policy.maxEntries} entries are allowed`]);
  }

  const reasons: string[] = [];
  const seen = new Set<string>();

  for (const raw of entries) {
    try {
      const cidr = normalizeEntry(raw.trim(), policy);
      if (seen.has(cidr)) continue;
      seen.add(cidr);
    } catch (err) {
      reasons.push(`${JSON.stringify(raw)}: ${(err as Error).message}`);
    }
  }

  if (reasons.length > 0) throw new ValidationError(reasons);
  return [...seen].sort();
}

function normalizeEntry(entry: string, policy: Policy): string {
  const [address, prefixPart, ...rest] = entry.split('/');
  if (rest.length > 0) throw new Error('malformed CIDR');

  if (!isIPv4(address)) {
    // Named separately from "not a valid IP address" so the caller can tell a
    // typo from an unsupported address family.
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
