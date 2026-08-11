import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';

/**
 * Publishes the OpenAPI document generated from the route schemas, and serves
 * Swagger UI at /docs. The spec is derived from the same schemas Fastify
 * validates against, so it cannot drift from the implementation.
 *
 * Disabled by default in production - the portal team consumes the spec from
 * CI, and an internal API has no reason to expose an interactive console.
 *
 * Called directly on the root instance rather than through `app.register`:
 * both plugins de-encapsulate themselves, so wrapping them in another plugin
 * scope would hide every route registered outside that scope.
 */
export function registerDocs(app: FastifyInstance): void {
  app.register(swagger, {
    openapi: {
      info: {
        title: 'WebSG Custom - CMS IP Allowlist API',
        description:
          'Self-service management of the IP addresses allowed to reach a tenant CMS. ' +
          'Writes are stored as desired state and applied to AWS WAF asynchronously.',
        version: '1.0.0',
      },
      servers: [{ url: '/', description: 'Current host' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'Access token issued by the portal IdP. Requires the ip-allowlist:read / ' +
              'ip-allowlist:write scope, or platform:admin for the operations team.',
          },
        },
      },
      tags: [
        { name: 'ip-allowlist', description: 'Tenant CMS IP allowlist' },
        { name: 'health', description: 'Probes' },
      ],
    },
  });

  app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });
}
