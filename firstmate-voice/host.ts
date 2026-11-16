// FirstMate voice — the host entry.
//
// Runs on the machine whose bb desktop app holds the call, in a worker that machine's bb host daemon starts,
// so the voice hook acts on that machine and not on the one running the bb server. It runs only this
// machine's own hook file (`~/.config/firstmate-voice/hook`, `host/run-hook.ts`); no call names a command or
// a path, and none reads what is in the file.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";

import { hostContract } from "./shared/host-contract";
import { hookStatus, killRunningHooks, runHook } from "./host/run-hook";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    status: () => hookStatus(),
    run: ({ event, reason }) => runHook(event, reason),
  },
  // A reload, disable or removal of the plugin, or the daemon stopping: no hook outlives the worker.
  dispose: () => killRunningHooks(),
});
