import type { FastifyInstance } from 'fastify';
import {
  ForbiddenError,
  NotFoundError,
  PreconditionRequiredError,
  ValidationError,
  VersionConflictError,
} from '../lib/errors.ts';

/** Single place mapping domain errors to HTTP, and the only error responder. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not found' }));

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ValidationError) {
      return reply.code(400).send({ error: error.message, reasons: error.reasons });
    }
    if (error instanceof ForbiddenError) {
      return reply.code(403).send({ error: error.message });
    }
    if (error instanceof NotFoundError) {
      return reply.code(404).send({ error: error.message });
    }
    if (error instanceof VersionConflictError) {
      return reply.code(409).send({ error: error.message });
    }
    if (error instanceof PreconditionRequiredError) {
      return reply.code(428).send({ error: error.message });
    }

    const err = error as { validation?: unknown; message?: string; statusCode?: number };
    if (err.validation) {
      return reply.code(400).send({ error: 'request does not match schema', reasons: [err.message] });
    }

    // Never leak internals (stack traces, AWS errors) to the portal.
    request.log.error({ err }, 'unhandled error');
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    return reply.code(status).send({ error: status === 500 ? 'internal error' : err.message });
  });
}
