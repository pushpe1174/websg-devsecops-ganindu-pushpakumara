import { isIPv4, isIPv6 } from 'node:net';
import type { Config } from '../config/index.ts';
import { ValidationError } from './errors.ts';

type Policy = Config['policy'];

/**
 * Validates and canonicalises tenant-submitted entries into WAF IPSet form.
 * Accepts a bare IP (widened to /32 or /128) or an explicit CIDR.
 * Rejects: malformed input, non-routable ranges, ranges broader than policy,
 * and CIDRs whose host bits are set (WAF requires the network address).
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

  const v4 = isIPv4(address);
  if (!v4 && !isIPv6(address)) throw new Error('not a valid IP address');

  const maxPrefix = v4 ? 32 : 128;
  const minPrefix = v4 ? policy.minPrefixV4 : policy.minPrefixV6;
  const prefix = prefixPart === undefined ? maxPrefix : Number(prefixPart);

  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new Error('prefix length out of range');
  }
  if (prefix < minPrefix) {
    throw new Error(`range too broad, use /${minPrefix} or narrower`);
  }

  const bytes = toBytes(address, v4);
  if (!isPubliclyRoutable(bytes, v4)) {
    throw new Error('private, loopback, link-local or reserved ranges are not allowed');
  }
  if (hasHostBits(bytes, prefix)) {
    throw new Error(`host bits set, use the network address for /${prefix}`);
  }

  return `${v4 ? address : compressIPv6(bytes)}/${prefix}`;
}

function toBytes(address: string, v4: boolean): number[] {
  if (v4) return address.split('.').map(Number);

  // Expand "::" then split into 8 groups of 16 bits.
  const [head, tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];

  return groups.flatMap((g) => {
    const value = parseInt(g, 16);
    return [value >> 8, value & 0xff];
  });
}

function compressIPv6(bytes: number[]): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);

  // Find the longest run of zero groups (2 or more) and collapse it to "::".
  let start = -1;
  let length = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] !== 0) continue;
    let end = i;
    while (end < 8 && groups[end] === 0) end++;
    if (end - i > length) [start, length] = [i, end - i];
    i = end;
  }

  const hex = groups.map((g) => g.toString(16));
  if (length < 2) return hex.join(':');
  return `${hex.slice(0, start).join(':')}::${hex.slice(start + length).join(':')}`;
}

function hasHostBits(bytes: number[], prefix: number): boolean {
  return bytes.some((byte, i) => {
    const bitsBefore = i * 8;
    if (prefix >= bitsBefore + 8) return false;
    const keep = Math.max(0, prefix - bitsBefore);
    return (byte & (0xff >> keep)) !== 0;
  });
}

function isPubliclyRoutable(bytes: number[], v4: boolean): boolean {
  if (v4) {
    const [a, b] = bytes;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-network, RFC1918, loopback, multicast/reserved
    if (a === 100 && b >= 64 && b < 128) return false; // CGNAT
    if (a === 169 && b === 254) return false; // link-local
    if (a === 172 && b >= 16 && b < 32) return false; // RFC1918
    if (a === 192 && b === 168) return false; // RFC1918
    return true;
  }

  const first = bytes[0];
  if (bytes.slice(0, 15).every((byte) => byte === 0)) return false; // :: and ::1 loopback
  if (first === 0xff) return false; // multicast
  if (first === 0xfe && (bytes[1] & 0xc0) === 0x80) return false; // link-local fe80::/10
  if ((first & 0xfe) === 0xfc) return false; // unique local fc00::/7
  return true;
}
