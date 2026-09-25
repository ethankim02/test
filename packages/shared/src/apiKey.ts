import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * API keys are opaque bearer tokens; only their SHA-256 hash is ever
 * persisted, so a database read alone never discloses a usable credential.
 * This is a deliberately simple scheme for a local/demo deployment — see
 * docs/THREAT_MODEL.md for what a production auth system would need
 * beyond this (key rotation, scoped permissions, expiry).
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function apiKeyHashEquals(hashA: string, hashB: string): boolean {
  const bufA = Buffer.from(hashA, 'hex');
  const bufB = Buffer.from(hashB, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
