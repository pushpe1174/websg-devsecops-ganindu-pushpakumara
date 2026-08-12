/**
 * The user directory, standing in for an IdP. The tenant comes from here and
 * never from the token, so a forged claim cannot reach another tenant's list.
 * A user owns one list; users on one tenant share its IPSet as a union.
 */
export const USERS: Record<string, string> = {
  'user-a': 'tenant-a',
  'user-b': 'tenant-b',
  'user-c': 'tenant-shared',
  'user-d': 'tenant-shared',
};

export const tenantOf = (userId: string): string | undefined => USERS[userId];
