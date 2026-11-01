/**
 * Which machines "+" offers, and whether it needs to ask. No SDK import.
 */
import type { HostChoice } from "./tabs";

/** The fields of a bb host (`bb.sdk.hosts.list()`) this file reads. */
export interface HostRecord {
  id: string;
  name: string;
  status: "connected" | "disconnected";
  lifecycle: { phase: string };
}

/**
 * The machines a terminal can open on: connected and active ones (a suspended
 * or half-removed machine has no shell to give), the server's own machine
 * first, then by name.
 */
export function selectableHosts(hosts: readonly HostRecord[], primaryHostId: string | null): HostChoice[] {
  return hosts
    .filter((host) => host.status === "connected" && host.lifecycle.phase === "active")
    .map((host) => ({ id: host.id, name: host.name }))
    .sort((a, b) => {
      if (a.id === primaryHostId) return -1;
      if (b.id === primaryHostId) return 1;
      return a.name.localeCompare(b.name);
    });
}

export type PlusAction =
  | { kind: "none" }
  | { kind: "open"; hostId: string }
  | { kind: "ask"; hosts: HostChoice[] };

/** What "+" does: nothing to offer, open on the only machine, or ask which one. */
export function plusAction(hosts: readonly HostChoice[]): PlusAction {
  if (hosts.length === 0) return { kind: "none" };
  if (hosts.length === 1) return { kind: "open", hostId: hosts[0]!.id };
  return { kind: "ask", hosts: [...hosts] };
}
