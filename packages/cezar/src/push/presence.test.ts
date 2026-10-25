import { describe, expect, it } from 'vitest';
import { createPresenceBeats, PRESENCE_BEAT_TTL_MS } from './presence.ts';

describe('createPresenceBeats', () => {
  it('holds an account while any of its tabs beat, until the beat lapses or the tab says it hid', () => {
    let now = 0;
    const beats = createPresenceBeats(() => now);
    expect(beats.visible('alice')).toBe(false);
    beats.beat('alice', 'a', true);
    beats.beat('alice', 'b', true);
    beats.beat('alice', 'a', false);
    expect(beats.visible('alice')).toBe(true);
    expect(beats.visible('bob')).toBe(false);
    now += PRESENCE_BEAT_TTL_MS;
    expect(beats.visible('alice')).toBe(false);
  });
});
