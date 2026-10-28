/**
 * The plugin's host entry, as the server calls it: git on the machine that holds a workspace, for the
 * views bb's Git plugin does not give. A host that cannot be reached, or runs a bb too old for host
 * entries, answers with an error the tab shows as is.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { HostDiffSpec } from "../shared/git-spec";
import { hostContract, type HostDiff } from "../shared/host-contract";

export type HostGit = (hostId: string, root: string, spec: HostDiffSpec, ignoreWhitespace: boolean) => Promise<HostDiff>;

export function createHostGit(bb: BbPluginApi): HostGit {
  const client = bb.hosts.experimental_client({ contract: hostContract });
  return (hostId, root, spec, ignoreWhitespace) => client.call("diff", { root, spec, ignoreWhitespace }, { hostId });
}
