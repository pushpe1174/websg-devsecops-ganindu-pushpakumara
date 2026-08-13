import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { config as defaultConfig, type Config } from '../config/index.ts';
import type { AllowlistRepository, SyncNotifier, TokenVerifier } from '../domain/ports.ts';
import { createAllowlistService } from '../services/allowlist-service.ts';
import { registerAuthentication } from './plugins/auth.ts';
import { registerErrorHandler } from './plugins/error-handler.ts';
import { allowlistRoutes } from './routes/allowlist.ts';
import { authRoutes } from './routes/auth.ts';
import { healthRoutes } from './routes/health.ts';

export type AppOptions = {
  repository: AllowlistRepository;
  notifier: SyncNotifier;
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

  app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    methods: ['GET', 'PUT', 'POST', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'if-match'],
    exposedHeaders: ['etag'],
    credentials: false,
    maxAge: 600,
  });

  app.register(healthRoutes);

  app.register(authRoutes(config));

  // Everything under /v1 is authenticated; health stays outside this scope.
  app.register(
    async (api) => {
      registerAuthentication(api, options.verify);
      const service = createAllowlistService({
        repository: options.repository,
        notifier: options.notifier,
        config,
        logger: api.log,
      });
      await api.register(allowlistRoutes(service));
    },
    { prefix: '/v1' },
  );

  return app;
}
