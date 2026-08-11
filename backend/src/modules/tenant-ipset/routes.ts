import type { FastifyInstance } from 'fastify';
import { ForbiddenError, NotFoundError } from '../../lib/errors.ts';
import { ADMIN_SCOPE } from '../../lib/jwt.ts';
import { errorResponseSchema, tenantParamsSchema } from '../ip-allowlist/schemas.ts';
import type { TenantIpSet, TenantIpSetRepository } from './repository.ts';

const assignmentSchema = {
  type: 'object',
  required: ['ipSetId', 'ipSetName'],
  additionalProperties: false,
  properties: {
    ipSetId: {
      type: 'string',
      pattern: '^[0-9a-fA-F-]{36}$',
      description: 'Id of an existing WAF IPSet.',
      examples: ['a1b2c3d4-1111-2222-3333-444455556666'],
    },
    ipSetName: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      examples: ['websg-cms-allowlist-agency-c'],
    },
    ipSetScope: { type: 'string', enum: ['REGIONAL', 'CLOUDFRONT'], default: 'REGIONAL' },
    description: { type: 'string', maxLength: 256 },
  },
} as const;

const assignmentResponseSchema = {
  type: 'object',
  properties: {
    tenantId: { type: 'string' },
    ipSetId: { type: 'string' },
    ipSetName: { type: 'string' },
    ipSetScope: { type: 'string' },
    description: { type: 'string' },
  },
} as const;

const errors = (...codes: number[]) =>
  Object.fromEntries(codes.map((code) => [code, errorResponseSchema]));

/**
 * Platform-admin management of the tenant -> IPSet mapping the sync worker
 * reads. Terraform seeds this at onboarding; these routes let the ops team
 * reassign, share or detach an IPSet without a deploy.
 */
export function tenantIpSetRoutes(repository: TenantIpSetRepository) {
  return async function routes(app: FastifyInstance) {
    // Every route here is admin-only; no tenant may see or change the mapping.
    app.addHook('preHandler', async (request) => {
      if (!request.principal.isPlatformAdmin) {
        request.log.warn({ subject: request.principal.subject }, 'non-admin hit admin route');
        throw new ForbiddenError(`this endpoint requires the ${ADMIN_SCOPE} scope`);
      }
    });

    app.get(
      '/ip-set-assignments',
      {
        schema: {
          tags: ['admin'],
          summary: 'List every tenant to IPSet assignment',
          security: [{ bearerAuth: [] }],
          response: {
            200: { type: 'array', items: assignmentResponseSchema },
            ...errors(401, 403),
          },
        },
      },
      async () => repository.list(),
    );

    app.get(
      '/tenants/:tenantId/ip-set',
      {
        schema: {
          tags: ['admin'],
          summary: 'Read one tenant IPSet assignment',
          security: [{ bearerAuth: [] }],
          params: tenantParamsSchema,
          response: { 200: assignmentResponseSchema, ...errors(400, 401, 403, 404) },
        },
      },
      async (request) => {
        const { tenantId } = request.params as { tenantId: string };
        const assignment = await repository.get(tenantId);

        if (!assignment) throw new NotFoundError('no IPSet assigned to this tenant');
        return assignment;
      },
    );

    app.put(
      '/tenants/:tenantId/ip-set',
      {
        schema: {
          tags: ['admin'],
          summary: 'Assign or move a tenant to an IPSet',
          description:
            'Point two tenants at the same IPSet to have them share it - the worker applies the ' +
            'union of their lists. Give a tenant its own IPSet for full isolation. The tenant is ' +
            'marked PENDING and re-synced immediately.',
          security: [{ bearerAuth: [] }],
          params: tenantParamsSchema,
          body: assignmentSchema,
          response: { 200: assignmentResponseSchema, ...errors(400, 401, 403) },
        },
      },
      async (request) => {
        const { tenantId } = request.params as { tenantId: string };
        const body = request.body as Omit<TenantIpSet, 'tenantId'>;

        const assignment = await repository.put({
          tenantId,
          ipSetId: body.ipSetId,
          ipSetName: body.ipSetName,
          ipSetScope: body.ipSetScope ?? 'REGIONAL',
          description: body.description ?? '',
        });

        // The tenant's list is not in the new IPSet yet, so say so and trigger
        // the sync in one move.
        await repository.markPending(tenantId);

        request.log.info(
          { tenantId, ipSetName: assignment.ipSetName, by: request.principal.subject },
          'ip set assigned',
        );
        return assignment;
      },
    );

    app.delete(
      '/tenants/:tenantId/ip-set',
      {
        schema: {
          tags: ['admin'],
          summary: 'Detach a tenant from its IPSet',
          description:
            'The tenant keeps its stored list but it is no longer applied anywhere, and its ' +
            'status stays PENDING. Removing the ranges from WAF is a separate re-sync of the ' +
            'IPSet it used to share.',
          security: [{ bearerAuth: [] }],
          params: tenantParamsSchema,
          response: { 204: { type: 'null' }, ...errors(400, 401, 403) },
        },
      },
      async (request, reply) => {
        const { tenantId } = request.params as { tenantId: string };

        await repository.remove(tenantId);
        await repository.markPending(tenantId);

        request.log.info({ tenantId, by: request.principal.subject }, 'ip set unassigned');
        return reply.code(204).send();
      },
    );
  };
}
