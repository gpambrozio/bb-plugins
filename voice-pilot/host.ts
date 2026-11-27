// Voice Pilot — the host entry.
//
// Runs on the machine whose bb desktop app holds the call, in a worker that machine's bb host daemon starts,
// so the voice hook acts on that machine and not on the one running the bb server. It runs only this
// machine's own hook file (`~/.config/voice-pilot/hook`, or `hook.sh` and the like: `host/run-hook.ts`); no call names a command or
// a path, and none reads what is in the file. Before each run it looks for bb's relay on this machine, so the
// hook's `bb` works on a machine joined through bb Connect (`host/relay.ts`, bb internals).
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";

import { hostContract } from "./shared/host-contract";
import { hookStatus, killRunningHooks, runMachineHook } from "./host/run-hook";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    status: () => hookStatus(),
    run: ({ event, reason }) => runMachineHook(event, reason),
  },
  // A reload, disable or removal of the plugin, or the daemon stopping: no hook outlives the worker.
  dispose: () => killRunningHooks(),
});
