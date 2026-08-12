import type { FastifyInstance } from 'fastify';

const schema = {
  response: { 200: { type: 'object', properties: { status: { type: 'string' } } } },
} as const;

/** Unauthenticated probes for the load balancer / container platform. */
export async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', { schema }, async () => ({ status: 'ok' }));
  app.get('/readyz', { schema }, async () => ({ status: 'ok' }));
}
