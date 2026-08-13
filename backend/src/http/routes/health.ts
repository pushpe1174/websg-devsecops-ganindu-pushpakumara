import type { FastifyInstance } from 'fastify';
import { healthSchema as schema } from '../schemas.ts';

/** Unauthenticated probes for the load balancer / container platform. */
export async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', { schema }, async () => ({ status: 'ok' }));
  app.get('/readyz', { schema }, async () => ({ status: 'ok' }));
}
