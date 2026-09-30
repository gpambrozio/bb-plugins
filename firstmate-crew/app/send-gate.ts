/**
 * One message to the first mate in flight at a time. A suggestion's button, Bearings and Ahoy, and the
 * palette's commands all send the captain's words, so a double press must not send them twice. Pure.
 *
 * The gate the app uses is in module scope, not component state: a tab switch can unmount the board while
 * a request is out, and the board that mounts next has to find the send still in flight.
 */

/** One task at a time; a second started while the first runs is refused. */
export interface SendGate {
  busy(): boolean;
  subscribe(listener: () => void): () => void;
  /** Starts `task` and resolves as it does, or returns null without starting it while another runs. */
  run<T>(task: () => Promise<T>): Promise<T> | null;
}

export function createSendGate(): SendGate {
  let running = false;
  const listeners = new Set<() => void>();
  function set(next: boolean): void {
    running = next;
    listeners.forEach((listener) => listener());
  }
  return {
    busy: () => running,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    run<T>(task: () => Promise<T>): Promise<T> | null {
      // Checked and shut synchronously, so two presses before a re-render still start one send.
      if (running) return null;
      set(true);
      let started: Promise<T>;
      try {
        started = task();
      } catch (error) {
        // A task that throws before it has a promise must not leave the gate shut.
        started = Promise.reject(error);
      }
      return started.finally(() => set(false));
    },
  };
}

/** The gate for the one first mate, for the life of the loaded bundle. */
export const mateSendGate: SendGate = createSendGate();
