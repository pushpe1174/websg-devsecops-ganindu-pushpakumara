import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { VersionConflictError } from '../../lib/errors.ts';

export type Allowlist = {
  tenantId: string;
  cidrs: string[];
  version: number;
  updatedAt: string;
  updatedBy: string;

  // Written by the sync worker once this version has reached AWS WAF. Absent
  // until then, which is what makes a new write PENDING by construction - a
  // stored status field could drift from reality; this cannot.
  syncedVersion?: number;
  syncedAt?: string;
};

export type AllowlistDraft = Omit<Allowlist, 'version' | 'updatedAt' | 'syncedVersion' | 'syncedAt'>;

export interface AllowlistRepository {
  get(tenantId: string): Promise<Allowlist | null>;
  /** Writes only if the stored version still matches `expectedVersion` (0 = create). */
  put(draft: AllowlistDraft, expectedVersion: number): Promise<Allowlist>;
}

export function createDynamoRepository(tableName: string): AllowlistRepository {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  return {
    async get(tenantId) {
      const { Item } = await client.send(new GetCommand({ TableName: tableName, Key: { tenantId } }));
      return (Item as Allowlist | undefined) ?? null;
    },

    async put(draft, expectedVersion) {
      // PutItem replaces the whole item, so `syncedVersion` is dropped here and
      // the new version starts out unacknowledged. The EventBridge Pipe filter
      // relies on this: a record without `syncedVersion` is a tenant edit, one
      // with it is the worker's own acknowledgement. Merging instead of
      // replacing would make the worker stop seeing tenant changes.
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
            Item: item,
            ConditionExpression: isCreate ? 'attribute_not_exists(tenantId)' : '#v = :expected',
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
