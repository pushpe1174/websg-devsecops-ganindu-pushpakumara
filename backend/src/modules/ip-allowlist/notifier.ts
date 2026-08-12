import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

export type SyncSignal = { tenantId: string; ownerId: string; version: number };

export interface SyncNotifier {
  /** Tells the worker a tenant has changed. Carries no allowlist data. */
  notify(signal: SyncSignal): Promise<void>;
}

/**
 * Signals the reconciler over the FIFO queue. This API is the table's only
 * writer, so it emits its own signal rather than routing a stream through a Pipe
 * to say the same thing. The queue stays because it is the mutex: FIFO allows
 * one in-flight batch per group and the group is the tenant, so two members
 * editing at once cannot become two writers to one IPSet.
 *
 * The body is a signal, not a payload - the worker rebuilds from the table - so
 * a duplicate or reordered delivery changes nothing.
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
          // Per logical edit: an SDK retry collapses to one message, while a
          // real second edit carries a new version and survives the 5-minute
          // dedup window.
          MessageDeduplicationId: `${tenantId}:${ownerId}:${version}`,
        }),
      );
    },
  };
}
