import { isIP } from 'node:net';

/**
 * Login backoff (spec `2026-10-12-cockpit-authentication.md` §5.4): exponential per key, capped,
 * never a hard lock — a lock would be a denial of service against the only owner. In memory:
 * a restart forgives, and the scrypt cost is the floor that does not.
 *
 * A key is `<kind>:<id>` and every kind has its own map, so failures that cost the caller nothing
 * (a rejected setup code, a new address) cannot evict the account keys.
 */
const FREE_FAILURES = 4;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 15 * 60_000;
/**
 * `user:` is the one key an anonymous caller can feed for someone else's account from any
 * address, so its delay stays short: it slows guessing without denying the owner (§5.4).
 */
const ACCOUNT_MAX_DELAY_MS = 60_000;
/** A key with no failure for this long starts over. */
const FORGET_AFTER_MS = 60 * 60_000;
const MAX_KEYS = 10_000;

interface Entry {
  failures: number;
  blockedUntil: number;
  lastFailure: number;
}

const kindOf = (key: string): string => key.slice(0, Math.max(0, key.indexOf(':')));

/**
 * What an address is throttled as: an IPv6 client owns its whole /64, so that is one caller
 * (§5.4). IPv4 is unchanged, and IPv4-mapped IPv6 is the IPv4 address it carries.
 */
export function throttleAddress(address: string): string {
  const bare = address.split('%')[0]!.toLowerCase();
  if (isIP(bare) !== 6) return address;
  const [head = '', tail] = bare.split('::');
  const groups = (part: string): string[] =>
    part === '' ? [] : part.split(':').flatMap((group) => {
      if (!group.includes('.')) return [group];
      const [a = 0, b = 0, c = 0, d = 0] = group.split('.').map(Number);
      return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
    });
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const full = [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    .map((group) => parseInt(group, 16) || 0);
  if (full.slice(0, 5).every((group) => group === 0) && full[5] === 0xffff) {
    return `${full[6]! >> 8}.${full[6]! & 255}.${full[7]! >> 8}.${full[7]! & 255}`;
  }
  return `${full.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`;
}

export class LoginThrottle {
  private readonly kinds = new Map<string, Map<string, Entry>>();
  /** Attempts admitted and not yet settled: failures-in-waiting, per key. */
  private readonly pending = new Map<string, number>();

  private entry(key: string): Entry | undefined {
    return this.kinds.get(kindOf(key))?.get(key);
  }

  /** Milliseconds the caller must wait, taking the worst of its keys. 0 = go ahead. */
  retryAfter(keys: readonly string[], now: number): number {
    let wait = 0;
    for (const key of keys) {
      const entry = this.entry(key);
      if (entry) wait = Math.max(wait, entry.blockedUntil - now);
    }
    return Math.max(0, wait);
  }

  /**
   * {@link retryAfter} for an attempt whose verdict arrives after an `await`: 0 also RESERVES the
   * attempt, and the caller owes one {@link settle}. In-flight attempts count as failures already
   * made, so a parallel burst gets exactly what the same guesses would get one after another.
   */
  reserve(keys: readonly string[], now: number): number {
    const wait = this.retryAfter(keys, now);
    if (wait > 0) return wait;
    for (const key of keys) {
      const pending = this.pending.get(key) ?? 0;
      const entry = this.entry(key);
      const failures = entry && now - entry.lastFailure < FORGET_AFTER_MS ? entry.failures : 0;
      if (pending > 0 && failures + pending > FREE_FAILURES) return BASE_DELAY_MS;
    }
    for (const key of keys) this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    return 0;
  }

  /** Ends a reservation. `failed` records the failure; a success or a shed request does not. */
  settle(keys: readonly string[], now: number, failed: boolean): void {
    for (const key of keys) {
      const pending = (this.pending.get(key) ?? 0) - 1;
      if (pending > 0) this.pending.set(key, pending);
      else this.pending.delete(key);
    }
    if (failed) this.fail(keys, now);
  }

  fail(keys: readonly string[], now: number): void {
    for (const key of keys) {
      const kind = kindOf(key);
      let entries = this.kinds.get(kind);
      if (!entries) this.kinds.set(kind, (entries = new Map()));
      const previous = entries.get(key);
      const failures = previous && now - previous.lastFailure < FORGET_AFTER_MS ? previous.failures + 1 : 1;
      const over = failures - FREE_FAILURES;
      const cap = kind === 'user' ? ACCOUNT_MAX_DELAY_MS : MAX_DELAY_MS;
      const delay = over <= 0 ? 0 : Math.min(cap, BASE_DELAY_MS * 2 ** (over - 1));
      // Re-insert so iteration order is recency: the prune below drops the stalest first.
      entries.delete(key);
      entries.set(key, { failures, blockedUntil: now + delay, lastFailure: now });
      for (const stale of entries.keys()) {
        if (entries.size <= MAX_KEYS) break;
        entries.delete(stale);
      }
    }
  }

  /** A success clears the ACCOUNT's count only — an address that guesses one right keeps its debt. */
  succeed(key: string): void {
    this.kinds.get(kindOf(key))?.delete(key);
  }
}
