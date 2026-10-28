// diff-review — the host entry.
//
// Runs on the machine that holds a workspace, in a worker bb's host daemon starts there, so the views
// bb's Git plugin does not offer (staged, unstaged, a range) read that machine's checkout, remote
// hosts included. It only reads: every command is a git read. See host/git.ts.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";

import { hostContract } from "./shared/host-contract";
import { createRunGit, diff } from "./host/git";

const runGit = createRunGit();

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    diff: ({ root, spec, ignoreWhitespace }) => diff(runGit, root, spec, ignoreWhitespace),
  },
});
