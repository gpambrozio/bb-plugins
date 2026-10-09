/**
 * The Macs the page offers, outside React: the page and the picker in its
 * title bar are separate React trees, so both read this one store.
 *
 * The page lists the machines when it opens and checks every one at once —
 * the server's own answer does not wait on a laptop's round trip — and checks
 * one again on request, never on its own: a check that failed mid-session
 * would swap the session for the not-ready view. Only each Mac's latest check
 * counts. The picked Mac is window state, so coming back to the page shows it
 * again.
 */
import { useSyncExternalStore } from "react";
import type { useRpc } from "@get-bb/plugin-sdk/app";

import type { HostEntry, ScreenStatus } from "../shared/channels";
import type { RpcContract } from "../shared/contract";

type Rpc = Pick<ReturnType<typeof useRpc<RpcContract>>, "call">;

/** What the page knows about one Mac's Screen Sharing. */
export interface HostCheck {
  status: ScreenStatus | null;
  error: string | null;
  checking: boolean;
}

export const UNCHECKED: HostCheck = { status: null, error: null, checking: true };

export interface HostsSnapshot {
  hosts: HostEntry[] | null;
  listError: string | null;
  checks: Record<string, HostCheck>;
  /** The Mac picked last in this window, if any. */
  picked: string | null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HostDirectory {
  private snapshot: HostsSnapshot = { hosts: null, listError: null, checks: {}, picked: null };
  private readonly listeners = new Set<() => void>();
  private readonly latest = new Map<string, number>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): HostsSnapshot => this.snapshot;

  /** Lists the machines, then checks each one. */
  refresh(rpc: Rpc): void {
    this.set({ listError: null });
    rpc
      .call("hosts", {})
      .then(({ hosts }) => {
        this.set({ hosts });
        for (const host of hosts) this.check(rpc, host.id);
      })
      .catch((error: unknown) => this.set({ listError: errorText(error) }));
  }

  check(rpc: Rpc, hostId: string): void {
    const asked = (this.latest.get(hostId) ?? 0) + 1;
    this.latest.set(hostId, asked);
    const current = () => this.latest.get(hostId) === asked;
    this.setCheck(hostId, { ...(this.snapshot.checks[hostId] ?? UNCHECKED), checking: true });
    rpc
      .call("status", { hostId })
      .then((status) => {
        if (current()) this.setCheck(hostId, { status, error: null, checking: false });
      })
      .catch((error: unknown) => {
        if (current()) this.setCheck(hostId, { ...(this.snapshot.checks[hostId] ?? UNCHECKED), error: errorText(error), checking: false });
      });
  }

  pick(hostId: string): void {
    this.set({ picked: hostId });
  }

  /** Forgets everything: a fresh window, for tests. */
  reset(): void {
    this.latest.clear();
    this.snapshot = { hosts: null, listError: null, checks: {}, picked: null };
    this.notify();
  }

  private setCheck(hostId: string, check: HostCheck): void {
    this.set({ checks: { ...this.snapshot.checks, [hostId]: check } });
  }

  private set(patch: Partial<HostsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const hostDirectory = new HostDirectory();

export function useHostDirectory(): HostsSnapshot {
  return useSyncExternalStore(hostDirectory.subscribe, hostDirectory.getSnapshot);
}

/** The Mac on show: the one picked, else one with a session in this window, else the server's. */
export function currentHost(snapshot: HostsSnapshot, liveHere: string[]): HostEntry | undefined {
  const hosts = snapshot.hosts ?? [];
  const byId = (id: string | null | undefined) => (id == null ? undefined : hosts.find((host) => host.id === id));
  return byId(snapshot.picked) ?? byId(liveHere.find((id) => byId(id) !== undefined)) ?? hosts.find((host) => host.isServer) ?? hosts[0];
}

export type Tone = "live" | "on" | "warning" | "neutral";

/** A Mac's state in a word or two, for the picker. */
export function hostNote(host: HostEntry, check: HostCheck | undefined, live: boolean): { text: string; tone: Tone } {
  if (live) return { text: "Live", tone: "live" };
  // The latest check knows better than the list read when the page opened.
  const status = check?.status ?? null;
  if (status === null && !host.connected) return { text: "Offline", tone: "neutral" };
  if (status === null) return check?.error != null ? { text: "Can't check", tone: "warning" } : { text: "Checking…", tone: "neutral" };
  switch (status.state) {
    case "ready":
      return { text: "On", tone: "on" };
    case "off":
    case "not-listening":
      return { text: "Screen Sharing off", tone: "neutral" };
    case "refused":
      return { text: "Refusing", tone: "warning" };
    case "unsupported":
      return { text: "Not a Mac", tone: "neutral" };
    case "offline":
      return { text: "Offline", tone: "neutral" };
    case "unreachable":
      return { text: "Can't check", tone: "warning" };
  }
}
