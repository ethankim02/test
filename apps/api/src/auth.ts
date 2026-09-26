import { DomainError, hashApiKey } from '@x402-treasury/shared';
import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

export interface AuthContext {
  orgId: string;
  /** Null for an org-level key (human/admin), set for an agent-scoped key. */
  agentId: string | null;
}

/**
 * Resolves the caller's org (and, if the key is agent-scoped, their
 * agent) from `Authorization: Bearer <key>`. Only the key's SHA-256 hash
 * ever touches the database (see `hashApiKey`). Agent-scoped keys are
 * what makes the authorization test in test/authorization.integration.test.ts
 * meaningful: an agent-scoped caller cannot spend another agent's budget
 * merely by putting a different `agentId` in the request body — see
 * `requireAgentMatch` below.
 */
export async function authenticate(pool: Pool, request: FastifyRequest): Promise<AuthContext> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new DomainError('UNAUTHORIZED', 'missing or malformed Authorization header');
  }
  const key = header.slice('Bearer '.length).trim();
  if (!key) {
    throw new DomainError('UNAUTHORIZED', 'empty bearer token');
  }
  const keyHash = hashApiKey(key);
  const { rows } = await pool.query<{ org_id: string; agent_id: string | null }>(
    'SELECT org_id, agent_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL',
    [keyHash],
  );
  const row = rows[0];
  if (!row) {
    throw new DomainError('UNAUTHORIZED', 'invalid or revoked API key');
  }
  return { orgId: row.org_id, agentId: row.agent_id };
}

/**
 * An agent-scoped key may only act as itself. An org-level key may act as
 * any agent in the org (a human operator / admin key). This is the
 * enforcement point for "an agent must not be able to consume another
 * agent's budget merely by changing agentId in JSON" (task §27).
 */
export function requireAgentMatch(auth: AuthContext, requestedAgentId: string): void {
  if (auth.agentId !== null && auth.agentId !== requestedAgentId) {
    throw new DomainError(
      'FORBIDDEN',
      `this API key is scoped to agent ${auth.agentId} and cannot act as ${requestedAgentId}`,
    );
  }
}
