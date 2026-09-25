/**
 * Injectable clock so tests can control "now" deterministically instead of
 * racing real wall-clock time (needed for reservation expiry, daily-limit
 * windows, and velocity checks).
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(at: Date): Clock {
  return { now: () => at };
}
