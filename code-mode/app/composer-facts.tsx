// What the Send-menu rows need to know about the new thread's project and machine, kept where their
// synchronous `disabled` checks can read it. bb asks a row's `disabled` with only the composer, so a
// contribution drawn in the new-thread composer (ComposerFacts, which draws nothing) loads Code Mode's
// switches, each machine's wrapper status, and the machines' and projects' names, and keeps them here.
import { experimental_useRpcQuery, useSdk } from "@get-bb/plugin-sdk/app";
import { useEffect } from "react";

import type { Config } from "../shared/config";
import { rpcContract } from "../shared/contract";

export interface ComposerFactsState {
  config: Config | null;
  /** Each machine checked since the plugin loaded. */
  statuses: Readonly<Record<string, { ok: boolean; message: string }>>;
  hostNames: Readonly<Record<string, string>>;
  projectNames: Readonly<Record<string, string>>;
}

const EMPTY: ComposerFactsState = { config: null, statuses: {}, hostNames: {}, projectNames: {} };
let current: ComposerFactsState = EMPTY;

export function composerFacts(): ComposerFactsState {
  return current;
}

export function setComposerFacts(update: Partial<ComposerFactsState>): void {
  current = { ...current, ...update };
}

export function resetComposerFacts(): void {
  current = EMPTY;
}

export function ComposerFacts() {
  const sdk = useSdk();
  const config = experimental_useRpcQuery({ contract: rpcContract, method: "config.get", input: {} });
  const statuses = experimental_useRpcQuery({ contract: rpcContract, method: "hosts.status", input: {} });

  useEffect(() => {
    if (config.data) setComposerFacts({ config: config.data });
  }, [config.data]);
  useEffect(() => {
    if (statuses.data) setComposerFacts({ statuses: statuses.data });
  }, [statuses.data]);
  useEffect(() => {
    let live = true;
    void Promise.all([sdk.hosts.list(), sdk.projects.list({ includePersonal: true })])
      .then(([hosts, projects]) => {
        if (!live) return;
        setComposerFacts({
          hostNames: Object.fromEntries(hosts.map((host) => [host.id, host.name])),
          projectNames: Object.fromEntries(projects.map((project) => [project.id, project.name])),
        });
      })
      // Without names a row says "this machine" and offers no opt-out; the dispatch hook still decides.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [sdk]);
  return null;
}
