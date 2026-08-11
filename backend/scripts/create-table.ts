/**
 * Creates the allowlist table in local DynamoDB. Idempotent.
 * In AWS this table is provisioned by Terraform, not by this script.
 */
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { config } from '../src/config/index.ts';

const client = new DynamoDBClient({});

// The allowlist table streams (it triggers the sync); the mapping table does
// not - it is configuration, and a change to it is picked up by the next sync.
await ensureTable(config.aws.tableName, true);
await ensureTable(config.aws.configTableName, false);

async function ensureTable(TableName: string, withStream: boolean) {
  try {
    await client.send(new DescribeTableCommand({ TableName }));
    console.log(`Table ${TableName} already exists`);
    return;
  } catch (err) {
    if ((err as Error).name !== 'ResourceNotFoundException') throw err;
  }

  await client.send(
    new CreateTableCommand({
      TableName,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'tenantId', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'tenantId', AttributeType: 'S' }],
      ...(withStream
        ? { StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' as const } }
        : {}),
    }),
  );
  console.log(`Created table ${TableName}`);
}
