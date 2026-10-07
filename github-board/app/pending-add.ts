/**
 * Add to chat, for a thread whose chat is not on screen: bb has no way to
 * write a draft that no composer shows, so the board opens the thread and
 * this store holds the card until the thread's composer appears.
 *
 * One pending card per window: while one waits, another is refused, and the
 * board's menu says why, so no card is ever dropped unseen. The app-wide
 * overlay (`PendingAddToChat`) delivers it, because opening the thread may
 * navigate away from the board, which unmounts the detail panel that asked.
 * Nothing persists: a card still pending at a reload is dropped.
 */
/** How long the overlay waits for the opened thread's composer before giving up. */
export const PENDING_ADD_TIMEOUT_MS = 15_000;

export interface PendingAdd {
  readonly id: number;
  readonly threadId: string;
  /** The thread's name, for the message when it never opens. */
  readonly title: string;
  /**
   * The card's prompt, rendered for the thread's project when it was picked,
   * so the overlay needs neither the templates nor the sidebar.
   */
  readonly prompt: string;
  /** Epoch milliseconds after which the card is dropped. */
  readonly deadline: number;
}

export interface PendingAdds {
  /** Holds the card, or returns null and holds nothing while another card is pending. */
  request(add: Omit<PendingAdd, "id" | "deadline">): PendingAdd | null;
  current(): PendingAdd | null;
  /** Removes and returns the pending card if it is still `id`, so it is delivered at most once. */
  take(id: number): PendingAdd | null;
  subscribe(listener: () => void): () => void;
}

export function createPendingAdds(now: () => number = Date.now): PendingAdds {
  let pending: PendingAdd | null = null;
  let nextId = 1;
  const listeners = new Set<() => void>();
  const set = (next: PendingAdd | null) => {
    pending = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    request(add) {
      if (pending !== null) return null;
      const next = { ...add, id: nextId++, deadline: now() + PENDING_ADD_TIMEOUT_MS };
      set(next);
      return next;
    },
    current: () => pending,
    take(id) {
      if (pending?.id !== id) return null;
      const taken = pending;
      set(null);
      return taken;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** This window's store, shared by the board's detail panel and the app overlay. */
export const pendingAdds = createPendingAdds();
