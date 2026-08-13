import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SyncNotifier } from '../domain/ports.ts';

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
