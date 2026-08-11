import Fastify, { type FastifyInstance } from 'fastify';
import { config as defaultConfig, type Config } from './config/index.ts';
import type { TokenVerifier } from './lib/jwt.ts';
import { ipAllowlistRoutes } from './modules/ip-allowlist/routes.ts';
import type { AllowlistRepository } from './modules/ip-allowlist/repository.ts';
import { createAllowlistService } from './modules/ip-allowlist/service.ts';
import { registerAuthentication } from './plugins/auth.ts';
import { registerErrorHandler } from './plugins/error-handler.ts';
import { healthRoutes } from './routes/health.ts';

export type AppOptions = {
  repository: AllowlistRepository;
  verify: TokenVerifier;
  config?: Config;
  logger?: boolean;
};

export function buildApp(options: AppOptions): FastifyInstance {
  const config = options.config ?? defaultConfig;

  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    bodyLimit: 64 * 1024,
    trustProxy: true,
    // A write waits for the WAF acknowledgement, so it outlives the default.
    requestTimeout: config.syncWaitMs + 15000,
  });

  registerErrorHandler(app);
  app.register(healthRoutes);

  // Everything under /v1 is authenticated; health routes stay outside this scope.
  app.register(
    async (api) => {
      registerAuthentication(api, options.verify);
      await api.register(ipAllowlistRoutes(createAllowlistService(options.repository, config)));
    },
    { prefix: '/v1' },
  );

  return app;
}
