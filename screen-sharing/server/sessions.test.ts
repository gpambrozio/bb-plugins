import { describe, expect, it, vi } from "vitest";

import { CloseCode, type SessionInfo } from "../shared/channels";
import { SessionRegistry } from "./sessions";

function setup(overrides: { maxTickets?: number } = {}) {
  let now = 1_000;
  let next = 0;
  const changes: SessionInfo[][] = [];
  const registry = new SessionRegistry({
    now: () => now,
    randomId: () => `id-${++next}`,
    ticketTtlMs: 30_000,
    idleMs: 60_000,
    maxAgeMs: 600_000,
    maxTickets: overrides.maxTickets ?? 16,
    onChange: (sessions) => changes.push(sessions),
  });
  return {
    registry,
    changes,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("tickets", () => {
  it("redeem once, for the Mac they were minted for", () => {
    const { registry } = setup();
    const { token, expiresAt } = registry.mint("mini");
    expect(expiresAt).toBe(31_000);
    expect(registry.redeem(token, "mini")).toEqual({ ok: true, hostId: "mini" });
    expect(registry.redeem(token, "mini")).toEqual({ ok: false, reason: "unknown or already used ticket" });
  });

  it("are used up by a try for another Mac", () => {
    const { registry } = setup();
    const { token } = registry.mint("mini");
    expect(registry.redeem(token, "laptop")).toEqual({ ok: false, reason: "ticket is for another Mac" });
    expect(registry.redeem(token, "mini").ok).toBe(false);
  });

  it("expire", () => {
    const { registry, advance } = setup();
    const { token } = registry.mint("mini");
    advance(30_000);
    expect(registry.redeem(token, "mini")).toEqual({ ok: false, reason: "expired ticket" });
  });

  it("refuse an unknown or empty token", () => {
    const { registry } = setup();
    registry.mint("mini");
    expect(registry.redeem("", "mini").ok).toBe(false);
    expect(registry.redeem("guess", "mini").ok).toBe(false);
  });

  it("keep only the newest few unredeemed", () => {
    const { registry } = setup({ maxTickets: 2 });
    const first = registry.mint("mini").token;
    const second = registry.mint("mini").token;
    const third = registry.mint("mini").token;
    expect(registry.redeem(first, "mini").ok).toBe(false);
    expect(registry.redeem(second, "mini").ok).toBe(true);
    expect(registry.redeem(third, "mini").ok).toBe(true);
  });
});

describe("sessions", () => {
  it("are listed while open and announced on every change", () => {
    const { registry, changes } = setup();
    const session = registry.open("mini", vi.fn());
    expect(registry.list()).toEqual([{ id: session.id, hostId: "mini", openedAt: 1_000, lastActivityAt: 1_000 }]);
    session.closed();
    session.closed();
    expect(registry.list()).toEqual([]);
    expect(changes.map((list) => list.length)).toEqual([1, 0]);
  });

  it("are ended when idle, and kept while bytes move", () => {
    const { registry, advance } = setup();
    const end = vi.fn();
    const session = registry.open("mini", end);
    advance(59_000);
    session.touch();
    advance(59_000);
    registry.sweep();
    expect(end).not.toHaveBeenCalled();
    advance(1_000);
    registry.sweep();
    expect(end).toHaveBeenCalledWith(CloseCode.idle, "no traffic for too long");
    expect(registry.list()).toEqual([]);
  });

  it("are ended at their maximum length however busy", () => {
    const { registry, advance } = setup();
    const end = vi.fn();
    const session = registry.open("mini", end);
    for (let elapsed = 0; elapsed < 600_000; elapsed += 30_000) {
      advance(30_000);
      session.touch();
      registry.sweep();
    }
    expect(end).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith(CloseCode.maxAge, "session reached its maximum length");
  });

  it("all end on Close all, once each", () => {
    const { registry, changes } = setup();
    const ends = [vi.fn(), vi.fn()];
    const sessions = ends.map((end) => registry.open("mini", end));
    expect(registry.closeAll()).toBe(2);
    for (const end of ends) expect(end).toHaveBeenCalledWith(CloseCode.closedByUser, "closed from bb");
    // The relay reports the sockets closing afterwards; that changes nothing.
    for (const session of sessions) session.closed();
    expect(registry.closeAll()).toBe(0);
    expect(changes.at(-1)).toEqual([]);
    expect(ends[0]).toHaveBeenCalledTimes(1);
  });

  it("are forgotten even when ending one throws", () => {
    const { registry } = setup();
    registry.open("mini", () => {
      throw new Error("socket already gone");
    });
    expect(() => registry.closeAll()).toThrow("socket already gone");
    expect(registry.list()).toEqual([]);
  });
});
