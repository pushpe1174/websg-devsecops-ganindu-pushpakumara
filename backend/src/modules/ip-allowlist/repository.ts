import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { VersionConflictError } from '../../lib/errors.ts';

export type Allowlist = {
  ownerId: string;
  cidrs: string[];
  version: number;
  updatedAt: string;

  // Written by the sync worker once this version is live in AWS WAF. Absent
  // until then, which is what makes a new write PENDING by construction - a
  // stored status field could drift from reality; this cannot.
  syncedVersion?: number;
  syncedAt?: string;
};

export type AllowlistDraft = { ownerId: string; cidrs: string[] };

export interface AllowlistRepository {
  get(tenantId: string, ownerId: string): Promise<Allowlist | null>;
  /** Writes only if the stored version still matches `expectedVersion` (0 = create). */
  put(tenantId: string, draft: AllowlistDraft, expectedVersion: number): Promise<Allowlist>;
}

/** One table per tenant, named `<prefix>-<tenantId>` - the same name as its IPSet. */
export function createDynamoRepository(tablePrefix: string): AllowlistRepository {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const tableOf = (tenantId: string) => `${tablePrefix}-${tenantId}`;

  return {
    async get(tenantId, ownerId) {
      const { Item } = await client.send(
        new GetCommand({
          TableName: tableOf(tenantId),
          Key: { ownerId },
          // The caller is polling for the worker's acknowledgement, so a stale
          // read would report PENDING on an already-applied list.
          ConsistentRead: true,
        }),
      );
      return (Item as Allowlist | undefined) ?? null;
    },

    async put(tenantId, draft, expectedVersion) {
      // PutItem replaces the whole item, so `syncedVersion` is dropped and the
      // new version starts unacknowledged. The Pipe filter relies on this: a
      // record without `syncedVersion` is a user edit, one with it is the
      // worker's own acknowledgement. Merging would hide edits from the worker.
      const item: Allowlist = {
        ...draft,
        version: expectedVersion + 1,
        updatedAt: new Date().toISOString(),
      };

      const isCreate = expectedVersion === 0;

      try {
        await client.send(
          new PutCommand({
            TableName: tableOf(tenantId),
            Item: item,
            ConditionExpression: isCreate ? 'attribute_not_exists(ownerId)' : '#v = :expected',
            ExpressionAttributeNames: isCreate ? undefined : { '#v': 'version' },
            ExpressionAttributeValues: isCreate ? undefined : { ':expected': expectedVersion },
          }),
        );
      } catch (err) {
        if ((err as Error).name === 'ConditionalCheckFailedException') {
          throw new VersionConflictError();
        }
        throw err;
      }

      return item;
    },
  };
}
