import type { Clock } from '@x402-treasury/shared';
import { systemClock } from '@x402-treasury/shared';
import type { Pool } from 'pg';
import { settleReservation } from './settle-reservation.js';

export interface ExpireSweepResult {
  expiredReservationIds: string[];
}

/**
 * Finds every reservation still ACTIVE past its `expires_at` and releases
 * it (entry_type EXPIRE). This is what prevents a crashed or abandoned
 * payment attempt from permanently locking funds — see
 * docs/ARCHITECTURE.md §12 "reservations must not be left permanently
 * locked after a crashed payment attempt."
 *
 * Each expiry is its own transaction (via `settleReservation`), so one
 * reservation failing to expire (e.g. a concurrent capture just won the
 * race) never blocks the rest of the sweep.
 */
export async function sweepExpiredReservations(pool: Pool, clock: Clock = systemClock): Promise<ExpireSweepResult> {
  const now = clock.now();
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM reservations WHERE status = 'ACTIVE' AND expires_at < $1`,
    [now.toISOString()],
  );

  const expired: string[] = [];
  for (const row of rows) {
    try {
      await settleReservation(pool, row.id, 'EXPIRE', clock);
      expired.push(row.id);
    } catch {
      // Lost a race with a concurrent capture/release for this specific
      // reservation (it's no longer ACTIVE) — not an error for the sweep
      // as a whole, just skip it and continue with the rest.
    }
  }
  return { expiredReservationIds: expired };
}
