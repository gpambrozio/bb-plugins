// FirstMate voice — the host entry.
//
// Runs on the machine whose bb desktop app holds the call, in a worker that machine's bb host daemon starts,
// so the voice hooks act on that machine and not on the one running the bb server. The server sends the
// command it holds for this machine; `host/run-hook.ts` runs it.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";

import { hostContract } from "./shared/host-contract";
import { killRunningHooks, runHook } from "./host/run-hook";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    run: ({ command, event, reason }) => runHook(event, reason, command),
  },
  // A reload, disable or removal of the plugin, or the daemon stopping: no hook outlives the worker.
  dispose: () => killRunningHooks(),
});
