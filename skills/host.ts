// skills — the host entry.
//
// Runs on the machine holding the thread's environment, in a worker bb's host
// daemon starts there, so discovery walks that machine's checkout or worktree
// and that user's provider homes — not the bb server's. The server entry calls
// it with the environment's host id. What each method does lives in
// host/discover.ts.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";

import { hostContract } from "./shared/host-contract";
import { discoverSkills, readDiscoveredSkill } from "./host/discover";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    discover: (input) => discoverSkills(input),
    read: (input) => readDiscoveredSkill(input),
  },
});
