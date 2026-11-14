// Herald — the host entry.
//
// Runs on the machine whose bb desktop app speaks, in a worker that machine's
// bb host daemon starts: the speech hooks act on that machine, not on the one
// running the bb server. The server sends the commands it holds for this
// machine. The runs of speech, and the after hook they owe, are kept here
// (`host/sessions.ts`); `host/run-hook.ts` runs each command.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";

import { HookSessions } from "./host/sessions";
import { runHook } from "./host/run-hook";
import { hostContract, hostSignals } from "./shared/host-contract";
import type { HookRun } from "./shared/speech-hooks";

/**
 * Where a lease expiry is reported: the signal of the latest call. A signal
 * keeps working after the call that handed it over has returned.
 */
let emitExpired: ((payload: { runId: string; after: HookRun | null }) => Promise<void>) | null = null;

/** Ends running hooks when the worker goes; its own `after` runs to completion first. */
const lifecycle = new AbortController();

const sessions = new HookSessions({
  run: (kind, command) => runHook(kind, command, { signal: lifecycle.signal }),
  expired: (runId, after) => {
    emitExpired?.({ runId, after }).catch((error: unknown) => {
      console.warn(`[herald] could not report an expired speech run: ${error instanceof Error ? error.message : String(error)}`);
    });
  },
});

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    begin: (input, context) => {
      emitExpired = (payload) => context.experimental_emitSignal("afterOnExpiry", payload);
      // Taken while this call runs, as the daemon requires; held while the run is open.
      return sessions.begin(input, context.experimental_retainWorker());
    },
    renew: ({ runId, leaseMs }) => ({ open: sessions.renew(runId, leaseMs) }),
    end: async ({ runId }) => ({ after: await sessions.end(runId) }),
  },
  // A reload, disable or removal of the plugin, or the daemon stopping: an owed after hook runs now.
  dispose: async () => {
    await sessions.dispose();
    lifecycle.abort();
  },
});
