import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

export type SyncSignal = { tenantId: string; ownerId: string; version: number };

export interface SyncNotifier {
  notify(signal: SyncSignal): Promise<void>;
}

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
