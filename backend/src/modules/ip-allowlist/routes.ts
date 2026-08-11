import type { FastifyInstance } from 'fastify';
import { PreconditionRequiredError } from '../../lib/errors.ts';
import { authorizeTenant } from '../../plugins/auth.ts';
import {
  allowlistResponseSchema,
  errorResponseSchema,
  replaceBodySchema,
  tenantParamsSchema,
  type ReplaceBody,
} from './schemas.ts';
import type { AllowlistService } from './service.ts';

const READ_SCOPE = 'ip-allowlist:read';
const WRITE_SCOPE = 'ip-allowlist:write';

const errors = (...codes: number[]) =>
  Object.fromEntries(codes.map((code) => [code, errorResponseSchema]));

export function ipAllowlistRoutes(service: AllowlistService) {
  return async function routes(app: FastifyInstance) {
    app.get(
      '/tenants/:tenantId/ip-allowlist',
      {
        schema: {
          tags: ['ip-allowlist'],
          summary: 'Read a tenant IP allowlist',
          description: `Requires the \`${READ_SCOPE}\` scope. A tenant with no allowlist yet returns an empty list at version 0.`,
          security: [{ bearerAuth: [] }],
          params: tenantParamsSchema,
          response: { 200: allowlistResponseSchema, ...errors(400, 401, 403) },
        },
      },
      async (request) => {
        const tenantId = authorizeTenant(request, READ_SCOPE);
        return service.get(tenantId);
      },
    );

    app.put(
      '/tenants/:tenantId/ip-allowlist',
      {
        schema: {
          tags: ['ip-allowlist'],
          summary: 'Replace a tenant IP allowlist',
          description:
            `Requires the \`${WRITE_SCOPE}\` scope. Send the complete list; it replaces the stored one. ` +
            'The `If-Match` header must carry the version last read, otherwise the write is rejected ' +
            '(428 when absent, 409 when stale). Returns **202 Accepted**: the list is stored and ' +
            '`syncStatus` is PENDING until the sync worker confirms it is live in AWS WAF, normally ' +
            'a few seconds. Poll GET until `syncStatus` reads APPLIED.',
          security: [{ bearerAuth: [] }],
          params: tenantParamsSchema,
          body: replaceBodySchema,
          headers: {
            // Documented, not schema-required: a missing If-Match is a 428, not a 400.
            type: 'object',
            properties: {
              'if-match': { type: 'string', description: 'Version last read.', examples: ['3'] },
            },
          },
          response: { 202: allowlistResponseSchema, ...errors(400, 401, 403, 409, 428) },
        },
      },
      async (request, reply) => {
        const tenantId = authorizeTenant(request, WRITE_SCOPE);
        const expectedVersion = parseIfMatch(request.headers['if-match']);

        const record = await service.replace({
          tenantId,
          cidrs: (request.body as ReplaceBody).cidrs,
          updatedBy: request.principal.subject,
          expectedVersion,
        });

        request.log.info(
          { tenantId, count: record.cidrs.length, version: record.version, by: record.updatedBy },
          'allowlist updated',
        );

        // 202, not 200: stored and durable, but not yet live in WAF.
        return reply.code(202).header('etag', String(record.version)).send(record);
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
