import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Allowlist } from '../domain/allowlist.ts';
import { VersionConflictError } from '../domain/errors.ts';
import type { AllowlistRepository } from '../domain/ports.ts';

/**
 * One table: PK = tenantId, SK = ownerId. A tenant is a partition, so the worker
 * reads one with a Query instead of scanning the platform.
 */
export function createDynamoRepository(tableName: string): AllowlistRepository {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  return {
    async get(tenantId, ownerId) {
      const { Item } = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { tenantId, ownerId },
          ConsistentRead: true,
        }),
      );
      return (Item as Allowlist | undefined) ?? null;
    },

    async put(tenantId, draft, expectedVersion) {
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
