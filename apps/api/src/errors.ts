import { DomainError, isDomainError } from '@x402-treasury/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/**
 * Every error response is `{ error: { code, message, details? } }` — never
 * a raw stack trace or a leaked database exception (task §30/§43). A
 * DomainError's own `httpStatus`/`code` drive the response; a ZodError
 * (request validation) maps to 400 VALIDATION_ERROR; anything else is an
 * unexpected 500 logged server-side but never echoed to the caller.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: Error, request: FastifyRequest, reply: FastifyReply) => {
    if (isDomainError(err)) {
      reply.status(err.httpStatus).send({ error: err.toJSON() });
      return;
    }
    if (err instanceof ZodError) {
      reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'request validation failed', details: { issues: err.issues } },
      });
      return;
    }
    request.log.error(err);
    reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'an unexpected error occurred' } });
  });
}

export function notFound(entity: string, id: string): DomainError {
  return new DomainError('NOT_FOUND', `${entity} ${id} not found`);
}
