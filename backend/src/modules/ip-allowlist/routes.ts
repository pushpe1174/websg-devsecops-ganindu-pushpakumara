import type { FastifyInstance } from 'fastify';
import { PreconditionRequiredError } from '../../lib/errors.ts';
import {
  allowlistResponseSchema,
  errorResponseSchema,
  replaceBodySchema,
  type ReplaceBody,
} from './schemas.ts';
import type { AllowlistService } from './service.ts';

const errors = (...codes: number[]) =>
  Object.fromEntries(codes.map((code) => [code, errorResponseSchema]));

/** The caller's own allowlist. The token decides whose - there is no id in the path. */
export function ipAllowlistRoutes(service: AllowlistService) {
  return async function routes(app: FastifyInstance) {
    app.get(
      '/allowlist',
      { schema: { response: { 200: allowlistResponseSchema, ...errors(401) } } },
      async (request) => service.get(request.principal),
    );

    app.put(
      '/allowlist',
      {
        schema: {
          body: replaceBodySchema,
          response: { 200: allowlistResponseSchema, 202: allowlistResponseSchema, ...errors(400, 401, 409, 428) },
        },
      },
      async (request, reply) => {
        // Send the complete list; it replaces the stored one. If-Match carries
        // the version last read (428 when absent, 409 when stale).
        const expectedVersion = parseIfMatch(request.headers['if-match']);

        const record = await service.replace({
          principal: request.principal,
          cidrs: (request.body as ReplaceBody).cidrs,
          expectedVersion,
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

        // 200 once WAF is confirmed updated; 202 if the wait elapsed first -
        // stored and durable, but not yet acknowledged. Poll GET for APPLIED.
        return reply
          .code(record.syncStatus === 'APPLIED' ? 200 : 202)
          .header('etag', String(record.version))
          .send(record);
      },
    );
  };
}

/** The version the client last read; guards against lost updates. */
function parseIfMatch(header: string | string[] | undefined): number {
  if (typeof header !== 'string') throw new PreconditionRequiredError();

  const version = Number(header.replaceAll('"', '').trim());
  if (!Number.isInteger(version) || version < 0) throw new PreconditionRequiredError();

  return version;
}
