import { describe, expect, it } from 'vitest';
import type { QueuedMessage } from '../runs/store.ts';
import { reorderPromptQueue } from './prompt-queue-order.ts';

const m = (id: string): QueuedMessage => ({ id, text: id, createdAt: '2026-10-24T00:00:00.000Z' });

describe('reorderPromptQueue (spec 2026-10-24-design-mode-third-cut §3.1)', () => {
  it('puts the queue in the named order, keeping every entry whole', () => {
    expect(reorderPromptQueue([m('a'), m('b'), m('c')], ['c', 'a', 'b'])).toEqual([m('c'), m('a'), m('b')]);
    expect(reorderPromptQueue([], [])).toEqual([]);
  });

  it('refuses any order that is not exactly the same set', () => {
    const queue = [m('a'), m('b')];
    expect(reorderPromptQueue(queue, ['a'])).toBeNull();
    expect(reorderPromptQueue(queue, ['a', 'b', 'c'])).toBeNull();
    expect(reorderPromptQueue(queue, ['a', 'a'])).toBeNull();
    expect(reorderPromptQueue(queue, ['a', 'x'])).toBeNull();
    expect(reorderPromptQueue([], ['a'])).toBeNull();
  });
});
