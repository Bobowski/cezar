/**
 * Login backoff (spec `2026-10-12-cockpit-authentication.md` §5.4): exponential per key, capped,
 * never a hard lock — a lock would be a denial of service against the only owner. In memory:
 * a restart forgives, and the scrypt cost is the floor that does not.
 */
const FREE_FAILURES = 4;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 15 * 60_000;
/** A key with no failure for this long starts over. */
const FORGET_AFTER_MS = 60 * 60_000;
const MAX_KEYS = 10_000;

interface Entry {
  failures: number;
  blockedUntil: number;
  lastFailure: number;
}

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();

  /** Milliseconds the caller must wait, taking the worst of its keys. 0 = go ahead. */
  retryAfter(keys: readonly string[], now: number): number {
    let wait = 0;
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) wait = Math.max(wait, entry.blockedUntil - now);
    }
    return Math.max(0, wait);
  }

  fail(keys: readonly string[], now: number): void {
    for (const key of keys) {
      const previous = this.entries.get(key);
      const failures = previous && now - previous.lastFailure < FORGET_AFTER_MS ? previous.failures + 1 : 1;
      const over = failures - FREE_FAILURES;
      const delay = over <= 0 ? 0 : Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (over - 1));
      // Re-insert so iteration order is recency: the prune below drops the stalest first.
      this.entries.delete(key);
      this.entries.set(key, { failures, blockedUntil: now + delay, lastFailure: now });
    }
    if (this.entries.size > MAX_KEYS) {
      for (const key of this.entries.keys()) {
        if (this.entries.size <= MAX_KEYS) break;
        this.entries.delete(key);
      }
    }
  }

  /** A success clears the ACCOUNT's count only — an address that guesses one right keeps its debt. */
  succeed(key: string): void {
    this.entries.delete(key);
  }
}
