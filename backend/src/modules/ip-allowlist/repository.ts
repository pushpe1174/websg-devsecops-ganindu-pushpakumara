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

/**
 * One table for the whole platform: PK = tenantId, SK = ownerId. A tenant is a
 * partition, so the sync worker reads one with a Query rather than scanning
 * every item on the platform.
 */
export function createDynamoRepository(tableName: string): AllowlistRepository {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  return {
    async get(tenantId, ownerId) {
      const { Item } = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { tenantId, ownerId },
          // The caller is polling for the worker's acknowledgement, so a stale
          // read would report PENDING on an already-applied list.
          ConsistentRead: true,
        }),
      );
      return (Item as Allowlist | undefined) ?? null;
    },

    async put(tenantId, draft, expectedVersion) {
      // PutItem replaces the whole item, so `syncedVersion` is dropped and the
      // new version starts unacknowledged - which is the truth: this version has
      // not reached WAF yet. Merging it forward would report a new edit as
      // already live.
      const item: Allowlist = {
        ...draft,
        version: expectedVersion + 1,
        updatedAt: new Date().toISOString(),
      };

      const isCreate = expectedVersion === 0;

      try {
        await client.send(
          new PutCommand({
            TableName: tableName,
            Item: { tenantId, ...item },
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
