/**
 * Answers shared between the components that hold the same key, while any of
 * them is mounted. The composer button and the popup bb mounts for it are
 * separate slots with no props between them, so this is how the popup opens on
 * the list the button already counted and how the popup's fresh scan updates
 * the button's count.
 *
 * A key's last answer is kept only while something subscribes to it, so a
 * thread left behind holds nothing.
 */
export interface AnswerChannel<T> {
  /** The last answer published for `key`, while anything subscribes to it. */
  last(key: string): T | undefined;
  publish(key: string, value: T): void;
  /** Calls `listener` with every answer published for `key`; returns the unsubscribe. */
  subscribe(key: string, listener: (value: T) => void): () => void;
}

export function createAnswerChannel<T>(): AnswerChannel<T> {
  const keys = new Map<string, { last: T | undefined; listeners: Set<(value: T) => void> }>();
  return {
    last: (key) => keys.get(key)?.last,
    publish(key, value) {
      const entry = keys.get(key);
      if (entry === undefined) return;
      entry.last = value;
      for (const listener of [...entry.listeners]) listener(value);
    },
    subscribe(key, listener) {
      let entry = keys.get(key);
      if (entry === undefined) {
        entry = { last: undefined, listeners: new Set() };
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
