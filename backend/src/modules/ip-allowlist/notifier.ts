import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

export type SyncSignal = { tenantId: string; ownerId: string; version: number };

export interface SyncNotifier {
  /** Tells the worker a tenant has changed. Carries no allowlist data. */
  notify(signal: SyncSignal): Promise<void>;
}

/**
 * Signals the reconciler over the FIFO queue.
 *
 * There is exactly one writer to the table and it is this API, so it emits its
 * own signal rather than routing a DynamoDB stream through a Pipe to say the
 * same thing. The queue stays because it is the mutex: FIFO allows one in-flight
 * batch per message group, and the group is the tenant, so two members of a
 * tenant editing at once can never produce two concurrent writers to that
 * tenant's IPSet.
 *
 * The message body is a signal, not a payload - the worker rebuilds the IPSet
 * from the table - so a duplicate or a reordered delivery changes nothing.
 */
export function createSqsNotifier(queueUrl: string): SyncNotifier {
  const client = new SQSClient({});

  return {
    async notify({ tenantId, ownerId, version }) {
      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({ source: 'api', tenantId, ownerId, version }),
          // One in-flight batch per tenant: the whole reason the queue is here.
          MessageGroupId: tenantId,
          // Per logical edit, so an SDK-level retry collapses to one message
          // while a genuine second edit - which has a new version - is never
          // swallowed by the 5-minute dedup window.
          MessageDeduplicationId: `${tenantId}:${ownerId}:${version}`,
        }),
      );
    },
  };
}
