// diff-review — the host entry.
//
// Runs on the machine that holds a workspace, in a worker bb's host daemon starts there, so the views
// bb's Git plugin does not offer (staged, unstaged, a range) read that machine's checkout, remote
// hosts included. It reads, but for Revert, which changes a file only while it still is the version
// the tab showed (host/revert.ts), and for fetching a pull request into the plugin's own refs. See
// host/git.ts.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";

import { hostContract } from "./shared/host-contract";
import { createRunGit, diff, fetchPull, indexState, rangeCommits } from "./host/git";
import { revert } from "./host/revert";

const runGit = createRunGit();

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    diff: ({ root, spec, ignoreWhitespace }) => diff(runGit, root, spec, ignoreWhitespace),
    indexState: async ({ root }) => ({ key: await indexState(runGit, root) }),
    rangeCommits: ({ root, spec }) => rangeCommits(runGit, root, spec),
    revert: async (input) => {
      await revert(runGit, input);
      return { ok: true as const };
    },
    fetchPull: ({ root, url, number, baseRef }) => fetchPull(runGit, root, url, number, baseRef),
  },
});
