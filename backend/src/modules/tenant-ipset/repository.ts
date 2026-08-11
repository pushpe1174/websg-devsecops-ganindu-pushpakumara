import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

/** Which WAF IPSet a tenant's allowlist is applied to. */
export type TenantIpSet = {
  tenantId: string;
  ipSetId: string;
  ipSetName: string;
  ipSetScope: 'REGIONAL' | 'CLOUDFRONT';
  description?: string;
};

export interface TenantIpSetRepository {
  get(tenantId: string): Promise<TenantIpSet | null>;
  list(): Promise<TenantIpSet[]>;
  put(assignment: TenantIpSet): Promise<TenantIpSet>;
  remove(tenantId: string): Promise<void>;
  /**
   * Clears the tenant's acknowledgement so the sync worker picks it up. A
   * reassigned tenant is genuinely unapplied until the new IPSet is written,
   * and this write is what puts a message on the queue.
   */
  markPending(tenantId: string): Promise<void>;
}

export function createDynamoTenantIpSetRepository(
  configTableName: string,
  allowlistTableName: string,
): TenantIpSetRepository {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  return {
    async get(tenantId) {
      const { Item } = await client.send(
        new GetCommand({ TableName: configTableName, Key: { tenantId } }),
      );
      return (Item as TenantIpSet | undefined) ?? null;
    },

    async list() {
      const items: TenantIpSet[] = [];
      let startKey: Record<string, unknown> | undefined;

      do {
        const page = await client.send(
          new ScanCommand({ TableName: configTableName, ExclusiveStartKey: startKey }),
        );
        items.push(...((page.Items ?? []) as TenantIpSet[]));
        startKey = page.LastEvaluatedKey;
      } while (startKey);

      return items.sort((a, b) => a.tenantId.localeCompare(b.tenantId));
    },

    async put(assignment) {
      await client.send(new PutCommand({ TableName: configTableName, Item: assignment }));
      return assignment;
    },

    async remove(tenantId) {
      await client.send(new DeleteCommand({ TableName: configTableName, Key: { tenantId } }));
    },

    async markPending(tenantId) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: allowlistTableName,
            Key: { tenantId },
            UpdateExpression: 'REMOVE syncedVersion, syncedAt',
            // Only if the tenant has an allowlist at all - nothing to apply
            // otherwise, and this must not create an empty item.
            ConditionExpression: 'attribute_exists(tenantId)',
          }),
        );
      } catch (err) {
        if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
      }
    },
  };
}
