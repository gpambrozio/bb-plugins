/**
 * This window's state for the agent panel, kept in module scope so it
 * outlives the page as the terminals do (app/live-terminals.ts): whether the
 * panel is open, what its new-thread composer starts with for each tab, the
 * failed commands the user waved away, and a count per tab of the commands
 * the agent typed there, which tells the tab to read its list again (the
 * list itself is the server's: it outlives the page and is shared by windows).
 * No React and no SDK.
 */
import type { FinishedCommand } from "../shared/shell-marks";

type Listener = () => void;

/** What a tab's new-thread composer starts with: the prompt, and a draft key so each ask starts a new draft. */
export interface AgentSeed {
  prompt: string;
  draftKey: string;
}

/** A command the tab's agent chat typed into the tab. */
export interface AgentTypedNote {
  command: string;
  at: number;
}

export interface AgentPanelState {
  open: boolean;
  seeds: ReadonlyMap<string, AgentSeed>;
  /** Per tab, how many times the agent has typed there while this window listened: a change means read the list again. */
  typed: ReadonlyMap<string, number>;
}

export function createAgentPanelStore() {
  let state: AgentPanelState = { open: false, seeds: new Map(), typed: new Map() };
  const listeners = new Set<Listener>();
  const dismissed = new WeakSet<FinishedCommand>();
  /** Counts the asks, so each one starts a draft of its own (the time keeps keys apart across reloads). */
  let asks = 0;
  const set = (next: AgentPanelState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Opens the panel; with a prompt, the tab's composer starts a new draft on it. */
    open(terminalId: string, prompt: string | null) {
      const seeds = new Map(state.seeds);
      if (prompt !== null) seeds.set(terminalId, { prompt, draftKey: `terminals-agent:${terminalId}:${Date.now().toString(36)}-${++asks}` });
      set({ ...state, open: true, seeds });
    },
    close() {
      if (state.open) set({ ...state, open: false });
    },
    /** The tab's composer has started its thread: the next one starts afresh. */
    clearSeed(terminalId: string) {
      if (!state.seeds.has(terminalId)) return;
      const seeds = new Map(state.seeds);
      seeds.delete(terminalId);
      set({ ...state, seeds });
    },
    /** The agent typed into the tab: its list has changed on the server. */
    noteTyped(terminalId: string) {
      const typed = new Map(state.typed);
      typed.set(terminalId, (state.typed.get(terminalId) ?? 0) + 1);
      set({ ...state, typed });
    },
    /** The user waved the offer for this failed command away. */
    dismiss(command: FinishedCommand) {
      dismissed.add(command);
      set({ ...state });
    },
    isDismissed: (command: FinishedCommand) => dismissed.has(command),
  };
}

export type AgentPanelStore = ReturnType<typeof createAgentPanelStore>;

export const windowAgentPanel: AgentPanelStore = createAgentPanelStore();
