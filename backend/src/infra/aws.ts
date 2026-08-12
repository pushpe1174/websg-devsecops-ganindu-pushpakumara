import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Allowlist, AllowlistRepository, SyncNotifier } from '../core/allowlist.ts';
import { versionConflict } from '../core/errors.ts';

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

      // Version 0 means "no row yet", so the guard is existence, not a match.
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
        if ((err as Error).name === 'ConditionalCheckFailedException') throw versionConflict();
        throw err;
      }

      return item;
    },
  };
}

/** FIFO by tenant, deduplicated by version, so a retry is not a second sync. */
export function createSqsNotifier(queueUrl: string): SyncNotifier {
  const client = new SQSClient({});

  return {
    async notify({ tenantId, ownerId, version }) {
      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({ source: 'api', tenantId, ownerId, version }),
          MessageGroupId: tenantId,
          MessageDeduplicationId: `${tenantId}:${ownerId}:${version}`,
        }),
      );
    },
  };
}
