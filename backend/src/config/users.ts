/**
 * The user directory. No IdP: tokens are signed with JWT_SECRET and checked
 * here, and the tenant comes from this table - never from the token - so a
 * forged claim cannot reach another tenant's list.
 *
 * A user owns one list. Users on the same tenant share that tenant's table and
 * its WAF IPSet; the worker applies the union of their lists.
 */
export const USERS: Record<string, string> = {
  'user-a': 'tenant-a',
  'user-b': 'tenant-b',
  'user-c': 'tenant-shared',
  'user-d': 'tenant-shared',
};

export const tenantOf = (userId: string): string | undefined => USERS[userId];
