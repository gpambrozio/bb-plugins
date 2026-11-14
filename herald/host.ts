// Herald — the host entry.
//
// Runs on the machine whose bb desktop app speaks, in a worker that machine's
// bb host daemon starts: the speech hooks act on that machine, not on the one
// running the bb server. The server sends the commands it holds for this
// machine. The runs of speech, and the after hook they owe, are kept here
// (`host/sessions.ts`); `host/run-hook.ts` runs each command.
import { hostname } from "node:os";

import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";

import { hookFailure, type HookRun } from "./shared/speech-hooks";
import { hostContract, hostSignals } from "./shared/host-contract";
import { killRunningHooks, runHook } from "./host/run-hook";
import { HookSessions } from "./host/sessions";

type AfterWithoutWindow = { reason: "expired" | "disposed"; runIds: string[]; after: HookRun | null };

/**
 * How a run the machine ended by itself reaches the server: the signal of the
 * latest call (a signal keeps working after its call has returned). Null
 * until a run has been opened, and then nothing is owed.
 */
let emitAfter: ((payload: AfterWithoutWindow) => Promise<void>) | null = null;

/**
 * Says what the machine ran without a window, both ways it can: to the
 * server, and on this worker's standard error, which the host daemon writes
 * to its own log ("Host plugin stderr") — the one that still works while the
 * worker shuts down and its link to the server may already be gone.
 */
async function reportAfter(payload: AfterWithoutWindow): Promise<void> {
  const why = payload.reason === "expired" ? "its window stopped answering" : "Herald's host worker was shutting down";
  const failure = payload.after === null ? null : hookFailure(payload.after);
  const outcome =
    payload.after === null ? "no after-speaking hook was set" : failure === null ? "the after-speaking hook ran" : `the after-speaking hook failed: ${failure}`;
  const line = `[herald] On ${hostname()}, a run of speech ended because ${why}; ${outcome}.\n`;
  const written = Promise.all([
    new Promise<void>((resolve) => process.stderr.write(line, () => resolve())),
    emitAfter?.(payload).catch(() => {}),
  ]);
  // Bounded: during a shutdown this runs inside bb's disposal budget.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([written, new Promise<void>((resolve) => (timer = setTimeout(resolve, REPORT_WAIT_MS)))]);
  clearTimeout(timer);
}

/** How long a report may hold a shutdown up; `DISPOSE_BUDGET_MS` plus this stays inside bb's 5 s. */
const REPORT_WAIT_MS = 500;

const sessions = new HookSessions({
  run: (kind, command, timeoutMs) => runHook(kind, command, timeoutMs === undefined ? {} : { timeoutMs }),
  kill: killRunningHooks,
  expired: (runId, after) => void reportAfter({ reason: "expired", runIds: [runId], after }),
});

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    begin: (input, context) => {
      emitAfter = (payload) => context.experimental_emitSignal("afterWithoutWindow", payload);
      // Taken while this call runs, as the daemon requires; held while the run is open.
      return sessions.begin(input, context.experimental_retainWorker());
    },
    renew: ({ runId, leaseMs }) => ({ open: sessions.renew(runId, leaseMs) }),
    end: async ({ runId }) => ({ after: await sessions.end(runId) }),
  },
  // A reload, disable or removal of the plugin, or the daemon stopping: an owed after hook runs now,
  // inside bb's 5 s disposal budget (`DISPOSE_BUDGET_MS`), and is reported.
  dispose: async () => {
    const report = await sessions.dispose();
    if (report !== null) await reportAfter({ reason: "disposed", ...report });
  },
});
