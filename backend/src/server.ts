import { buildApp } from './app.ts';
import { assertProductionConfig, config } from './config/index.ts';
import { createVerifier } from './lib/jwt.ts';
import { createDynamoRepository } from './modules/ip-allowlist/repository.ts';
import { createDynamoTenantIpSetRepository } from './modules/tenant-ipset/repository.ts';

assertProductionConfig(config);

const app = buildApp({
  repository: createDynamoRepository(config.aws.tableName),
  tenantIpSets: createDynamoTenantIpSetRepository(config.aws.configTableName, config.aws.tableName),
  verify: createVerifier(config),
  config,
});

// Let in-flight requests finish before the pod goes away.
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
