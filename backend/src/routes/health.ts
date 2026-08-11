import type { FastifyInstance } from 'fastify';

const schema = {
  tags: ['health'],
  summary: 'Liveness / readiness probe',
  response: { 200: { type: 'object', properties: { status: { type: 'string' } } } },
} as const;

/** Unauthenticated probes for the Kubernetes deployment and the ALB target group. */
export async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', { schema }, async () => ({ status: 'ok' }));
  app.get('/readyz', { schema }, async () => ({ status: 'ok' }));
}
