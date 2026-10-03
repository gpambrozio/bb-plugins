/**
 * Answers shared between the components that hold the same key, while any of
 * them is mounted. The composer button and the popup bb mounts for it are
 * separate slots with no props between them, so this is how the popup opens on
 * the list the button already counted and how the popup's fresh scan updates
 * the button's count.
 *
 * A key's last answer is kept only while something subscribes to it, so a
 * thread left behind holds nothing.
 *
 * Answers are ordered by when they were asked for, not when they arrived: a
 * holder takes a `ticket()` before it asks, and an answer asked for before the
 * last one published is dropped, so a slow old scan never overwrites a newer
 * one.
 */
export interface AnswerChannel<T> {
  /** The last answer published for `key`, while anything subscribes to it. */
  last(key: string): T | undefined;
  /** Taken before asking for an answer; later tickets are newer. */
  ticket(): number;
  /** Hands `value` to every subscriber of `key`, unless a newer answer is already out. Returns whether it did. */
  publish(key: string, value: T, ticket: number): boolean;
  /** Calls `listener` with every answer published for `key`; returns the unsubscribe. */
  subscribe(key: string, listener: (value: T) => void): () => void;
}

export function createAnswerChannel<T>(): AnswerChannel<T> {
  const keys = new Map<string, { last: T | undefined; ticket: number; listeners: Set<(value: T) => void> }>();
  let tickets = 0;
  return {
    last: (key) => keys.get(key)?.last,
    ticket: () => ++tickets,
    publish(key, value, ticket) {
      const entry = keys.get(key);
      if (entry === undefined || ticket < entry.ticket) return false;
      entry.last = value;
      entry.ticket = ticket;
      for (const listener of [...entry.listeners]) listener(value);
      return true;
    },
    subscribe(key, listener) {
      let entry = keys.get(key);
      if (entry === undefined) {
        entry = { last: undefined, ticket: 0, listeners: new Set() };
        keys.set(key, entry);
      }
      const current = entry;
      current.listeners.add(listener);
      return () => {
        current.listeners.delete(listener);
        if (current.listeners.size === 0 && keys.get(key) === current) keys.delete(key);
      };
    },
  };
}
