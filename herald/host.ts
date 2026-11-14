// Herald — the host entry.
//
// Runs on the machine whose bb desktop app speaks, in a worker that machine's
// bb host daemon starts: the speech hooks act on that machine, not on the one
// running the bb server. The server sends the command it holds for this
// machine; see `host/run-hook.ts` for how it runs.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";

import { runHook } from "./host/run-hook";
import { hostContract } from "./shared/host-contract";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    runHook: ({ kind, command }, context) => runHook(kind, command, { signal: context.signal }),
  },
});
