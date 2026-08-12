import { buildApp } from './app.ts';
import { createVerifier } from './infra/auth.ts';
import { createDynamoRepository, createSqsNotifier } from './infra/aws.ts';
import { assertConfig, config } from './config.ts';

assertConfig(config);

const app = buildApp({
  repository: createDynamoRepository(config.aws.tableName),
  notifier: createSqsNotifier(config.aws.syncQueueUrl!),
  verify: createVerifier(config),
  config,
});

// Let in-flight requests finish before the process goes away.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.fatal({ err }, 'failed to start');
  process.exit(1);
}
