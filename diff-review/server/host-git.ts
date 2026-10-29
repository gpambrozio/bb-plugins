/**
 * The plugin's host entry, as the server calls it: git on the machine that holds a workspace, for the
 * views bb's Git plugin does not give. A host that cannot be reached, or runs a bb too old for host
 * entries, answers with an error the tab shows as is.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { HostDiffSpec } from "../shared/git-spec";
import { hostContract, type HostDiff } from "../shared/host-contract";

export type HostGit = (hostId: string, root: string, spec: HostDiffSpec, ignoreWhitespace: boolean) => Promise<HostDiff>;

export type HostRevert = (hostId: string, input: { root: string; path: string; revision: string; hunks: number[] | null; patch: string | null }) => Promise<void>;

export type HostIndexState = (hostId: string, root: string) => Promise<string>;

export type HostRangeCommits = (hostId: string, root: string, spec: Extract<HostDiffSpec, { kind: "range" }>) => Promise<{ baseSha: string; headSha: string }>;

export function createHostRangeCommits(bb: BbPluginApi): HostRangeCommits {
  const client = bb.hosts.experimental_client({ contract: hostContract });
  return (hostId, root, spec) => client.call("rangeCommits", { root, spec }, { hostId });
}

export function createHostIndexState(bb: BbPluginApi): HostIndexState {
  const client = bb.hosts.experimental_client({ contract: hostContract });
  return async (hostId, root) => (await client.call("indexState", { root }, { hostId })).key;
}

export function createHostRevert(bb: BbPluginApi): HostRevert {
  const client = bb.hosts.experimental_client({ contract: hostContract });
  return async (hostId, input) => {
    await client.call("revert", input, { hostId });
  };
}
export type HostFetchPull = (hostId: string, input: { root: string; url: string; number: number; baseRef: string }) => Promise<{ headSha: string; baseSha: string }>;

export function createHostGit(bb: BbPluginApi): HostGit {
  const client = bb.hosts.experimental_client({ contract: hostContract });
  return (hostId, root, spec, ignoreWhitespace) => client.call("diff", { root, spec, ignoreWhitespace }, { hostId });
}

export function createHostFetchPull(bb: BbPluginApi): HostFetchPull {
  const client = bb.hosts.experimental_client({ contract: hostContract });
  return (hostId, input) => client.call("fetchPull", input, { hostId });
}
