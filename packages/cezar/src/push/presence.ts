/**
 * The HTTP half of "a cockpit tab of this account is visible" (spec 2026-10-24-mobile-cockpit
 * §3.5): a cockpit with no socket (hosted without cezar's sign-in) beats
 * `POST /workspace/push/presence` while its page is visible. A beat lasts `PRESENCE_BEAT_TTL_MS`,
 * so a tab that vanished without saying so stops holding push within one missed beat and a half.
 */

/** What the cockpit's beat interval (30 s) must stay under. */
export const PRESENCE_BEAT_TTL_MS = 45_000;

export interface PresenceBeats {
  /** One tab's word: still visible, or gone. */
  beat(account: string, tab: string, visible: boolean): void;
  visible(account: string): boolean;
}

export function createPresenceBeats(now: () => number = Date.now): PresenceBeats {
  const byAccount = new Map<string, Map<string, number>>();
  const live = (account: string): Map<string, number> | undefined => {
    const tabs = byAccount.get(account);
    if (!tabs) return undefined;
    const at = now();
    for (const [tab, seen] of tabs) if (at - seen >= PRESENCE_BEAT_TTL_MS) tabs.delete(tab);
    if (tabs.size === 0) byAccount.delete(account);
    return tabs.size > 0 ? tabs : undefined;
  };
  return {
    beat(account, tab, visible) {
      const tabs = live(account) ?? new Map<string, number>();
      if (visible) tabs.set(tab, now());
      else tabs.delete(tab);
      if (tabs.size > 0) byAccount.set(account, tabs);
      else byAccount.delete(account);
    },
    visible: (account) => live(account) !== undefined,
  };
}
