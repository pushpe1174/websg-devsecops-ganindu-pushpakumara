import Fastify, { type FastifyInstance } from 'fastify';
import { config as defaultConfig, type Config } from './config/index.ts';
import type { TokenVerifier } from './lib/jwt.ts';
import { ipAllowlistRoutes } from './modules/ip-allowlist/routes.ts';
import type { AllowlistRepository } from './modules/ip-allowlist/repository.ts';
import { createAllowlistService } from './modules/ip-allowlist/service.ts';
import { tenantIpSetRoutes } from './modules/tenant-ipset/routes.ts';
import type { TenantIpSetRepository } from './modules/tenant-ipset/repository.ts';
import { registerAuthentication } from './plugins/auth.ts';
import { registerDocs } from './plugins/docs.ts';
import { registerErrorHandler } from './plugins/error-handler.ts';
import { healthRoutes } from './routes/health.ts';

export type AppOptions = {
  repository: AllowlistRepository;
  tenantIpSets: TenantIpSetRepository;
  verify: TokenVerifier;
  config?: Config;
  logger?: boolean;
};

export function buildApp(options: AppOptions): FastifyInstance {
  const config = options.config ?? defaultConfig;

  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    bodyLimit: 64 * 1024,
    // Client IPs come from the ALB / API Gateway in front of the pod.
    trustProxy: true,
  });

  const service = createAllowlistService(options.repository, config);

  registerErrorHandler(app);

  // Registered before the routes so it can collect their schemas.
  if (config.docsEnabled) registerDocs(app);

  app.register(healthRoutes);

  // Everything under /v1 is authenticated; health routes stay outside this scope.
  app.register(
    async (api) => {
      registerAuthentication(api, options.verify);
      await api.register(ipAllowlistRoutes(service));
      // Admin surface: the tenant -> IPSet mapping the sync worker reads.
      await api.register(tenantIpSetRoutes(options.tenantIpSets), { prefix: '/admin' });
    },
    { prefix: '/v1' },
  );

  return app;
}
