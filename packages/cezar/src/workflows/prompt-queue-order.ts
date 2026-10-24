import type { QueuedMessage } from '../runs/store.ts';

/**
 * The prompt queue in the order `order` names (spec `2026-10-24-design-mode-third-cut` §3.1), or
 * null when `order` is not exactly the queue's ids: one missing, one extra or one twice. The
 * queue moves under the cockpit (a release, a send from another window), so a stale order is
 * refused rather than half-applied — the caller re-reads and asks again.
 */
export function reorderPromptQueue(queue: readonly QueuedMessage[], order: readonly string[]): QueuedMessage[] | null {
  if (order.length !== queue.length || new Set(order).size !== order.length) return null;
  const byId = new Map(queue.map((message) => [message.id, message]));
  const next: QueuedMessage[] = [];
  for (const id of order) {
    const message = byId.get(id);
    if (!message) return null;
    next.push(message);
  }
  return next;
}
