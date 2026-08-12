import Fastify, { type FastifyInstance } from 'fastify';
import {
  createAllowlistService,
  type AllowlistRepository,
  type SyncNotifier,
} from './core/allowlist.ts';
import { requireAuth, type TokenVerifier } from './infra/auth.ts';
import { config as defaultConfig, type Config } from './config.ts';
import { HttpError, preconditionRequired } from './core/errors.ts';

export type AppOptions = {
  repository: AllowlistRepository;
  notifier: SyncNotifier;
  verify: TokenVerifier;
  config?: Config;
  logger?: boolean;
};

const allowlistSchema = {
  type: 'object',
  properties: {
    ownerId: { type: 'string' },
    tenantId: { type: 'string' },
    cidrs: { type: 'array', items: { type: 'string' } },
    version: { type: 'integer' },
    updatedAt: { type: 'string' },
    syncStatus: { type: 'string', enum: ['PENDING', 'APPLIED'] },
    syncedVersion: { type: 'integer' },
    syncedAt: { type: 'string' },
  },
} as const;

const errorSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    reasons: { type: 'array', items: { type: 'string' } },
  },
} as const;

const bodySchema = {
  type: 'object',
  required: ['cidrs'],
  additionalProperties: false,
  properties: {
    cidrs: {
      type: 'array',
      maxItems: 200,
      items: { type: 'string', minLength: 1, maxLength: 43 },
    },
  },
} as const;

const errorsFor = (...codes: number[]) =>
  Object.fromEntries(codes.map((code) => [code, errorSchema]));

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

  // Unauthenticated probes for the load balancer / container platform.
  const healthSchema = {
    response: { 200: { type: 'object', properties: { status: { type: 'string' } } } },
  } as const;
  app.get('/healthz', { schema: healthSchema }, async () => ({ status: 'ok' }));
  app.get('/readyz', { schema: healthSchema }, async () => ({ status: 'ok' }));

  // Everything under /v1 is authenticated; health stays outside this scope.
  app.register(
    async (api) => {
      api.addHook('onRequest', requireAuth(options.verify));

      const service = createAllowlistService({
        repository: options.repository,
        notifier: options.notifier,
        config,
        logger: api.log,
      });

      // The caller's own allowlist - the token decides whose, no id in the path.
      api.get(
        '/allowlist',
        { schema: { response: { 200: allowlistSchema, ...errorsFor(401) } } },
        async (request) => service.get(request.principal),
      );

      api.put(
        '/allowlist',
        {
          schema: {
            body: bodySchema,
            response: {
              200: allowlistSchema,
              202: allowlistSchema,
              ...errorsFor(400, 401, 409, 428),
            },
          },
        },
        async (request, reply) => {
          // Full replacement. If-Match carries the version last read: 428 when
          // absent, 409 when stale.
          const record = await service.replace({
            principal: request.principal,
            cidrs: (request.body as { cidrs: string[] }).cidrs,
            expectedVersion: parseIfMatch(request.headers['if-match']),
          });

          request.log.info(
            {
              owner: record.ownerId,
              tenant: record.tenantId,
              count: record.cidrs.length,
              version: record.version,
              syncStatus: record.syncStatus,
            },
            'allowlist updated',
          );

          // 200 once WAF is confirmed; 202 if the wait elapsed first - durable,
          // just unacknowledged, so poll GET for APPLIED.
          return reply
            .code(record.syncStatus === 'APPLIED' ? 200 : 202)
            .header('etag', String(record.version))
            .send(record);
        },
      );
    },
    { prefix: '/v1' },
  );

  return app;
}

/** The version the client last read; guards against lost updates. */
function parseIfMatch(header: string | string[] | undefined): number {
  if (typeof header !== 'string') throw preconditionRequired();

  const version = Number(header.replaceAll('"', '').trim());
  if (!Number.isInteger(version) || version < 0) throw preconditionRequired();

  return version;
}

/** Single place mapping errors to HTTP, and the only error responder. */
function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not found' }));

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.status).send({ error: error.message, reasons: error.reasons });
    }

    const err = error as { validation?: unknown; message?: string; statusCode?: number };
    if (err.validation) {
      return reply
        .code(400)
        .send({ error: 'request does not match schema', reasons: [err.message] });
    }

    // Never leak internals (stack traces, AWS errors) to the portal.
    request.log.error({ err }, 'unhandled error');
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    return reply.code(status).send({ error: status === 500 ? 'internal error' : err.message });
  });
}
