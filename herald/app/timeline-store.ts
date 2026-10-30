/**
 * The places of each on-screen thread's sentences in its timeline
 * (`history.placed`), shared by every message of the thread in this window:
 * each message draws the sentences placed above it, and the thread reads once
 * for all of them.
 *
 * A thread reads when its first message shows; when a message newer than a
 * sentence still waiting for its place shows (the prompt after a finished
 * turn, mostly), once per message; when the server says it has a new
 * sentence; and after a reconnect. One read at a time, and a reason to read
 * during one asks for one more afterwards. A thread with no message on screen
 * is forgotten, so opening it again reads afresh.
 */
import type { PlacedSentences } from "../shared/herald";

export type LoadPlaced = (threadId: string) => Promise<PlacedSentences>;

interface ThreadState {
  data: PlacedSentences | null;
  busy: boolean;
  again: boolean;
  /** Messages that already asked for a read because they were newer than a waiting sentence. */
  asked: Set<string>;
  listeners: Set<() => void>;
}

/** What a read that failed leaves: nothing drawn, and no message asking again until the next nudge. */
const NOTHING: PlacedSentences = { sentences: [], waitingSince: null };

export class TimelineSentences {
  private readonly threads = new Map<string, ThreadState>();

  constructor(private readonly warn: (message: string, error: unknown) => void) {}

  subscribe(threadId: string, listener: () => void): () => void {
    const state = this.stateOf(threadId);
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
      if (state.listeners.size === 0 && this.threads.get(threadId) === state) this.threads.delete(threadId);
    };
  }

  snapshot(threadId: string): PlacedSentences | null {
    return this.threads.get(threadId)?.data ?? null;
  }

  /** A message of the thread is on screen. */
  shown(threadId: string, message: { id: string; createdAt: number }, load: LoadPlaced): void {
    const state = this.stateOf(threadId);
    if (state.data === null) {
      if (!state.busy) this.read(threadId, state, load);
      return;
    }
    const waitingSince = state.data.waitingSince;
    if (waitingSince === null || message.createdAt <= waitingSince || state.asked.has(message.id)) return;
    state.asked.add(message.id);
    this.read(threadId, state, load);
  }

  /** The server says the thread has a new sentence; only a thread on screen reads. */
  nudge(threadId: string, load: LoadPlaced): void {
    const state = this.threads.get(threadId);
    if (state !== undefined) this.read(threadId, state, load);
  }

  /** Whatever changed while the connection was down never arrives as a nudge. */
  refreshAll(load: LoadPlaced): void {
    for (const [threadId, state] of this.threads) this.read(threadId, state, load);
  }

  private stateOf(threadId: string): ThreadState {
    let state = this.threads.get(threadId);
    if (state === undefined) {
      state = { data: null, busy: false, again: false, asked: new Set(), listeners: new Set() };
      this.threads.set(threadId, state);
    }
    return state;
  }

  private read(threadId: string, state: ThreadState, load: LoadPlaced): void {
    if (state.busy) {
      state.again = true;
      return;
    }
    state.busy = true;
    load(threadId)
      .then(
        (data) => {
          state.data = data;
        },
        (error: unknown) => {
          this.warn(`Could not read where ${threadId}'s sentences sit in its timeline`, error);
          state.data ??= NOTHING;
        },
      )
      .finally(() => {
        state.busy = false;
        for (const listener of state.listeners) listener();
        if (state.again) {
          state.again = false;
          this.read(threadId, state, load);
        }
      });
  }
}

/** The one store of this window. */
export const timelineSentences = new TimelineSentences((message, error) => console.warn(`[herald] ${message}`, error));
