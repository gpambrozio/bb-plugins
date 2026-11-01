import { describe, expect, it } from "vitest";

import { plusAction, selectableHosts, type HostRecord } from "./host-choice";

function host(id: string, name: string, overrides: Partial<HostRecord> = {}): HostRecord {
  return { id, name, status: "connected", lifecycle: { phase: "active" }, ...overrides };
}

describe("selectableHosts", () => {
  it("offers only connected, active machines", () => {
    const hosts = selectableHosts(
      [
        host("a", "Alpha"),
        host("b", "Beta", { status: "disconnected" }),
        host("c", "Gamma", { lifecycle: { phase: "suspended" } }),
        host("d", "Delta", { lifecycle: { phase: "removing" } }),
      ],
      null,
    );
    expect(hosts).toEqual([{ id: "a", name: "Alpha" }]);
  });

  it("puts the server's own machine first, then the rest by name", () => {
    const hosts = selectableHosts([host("z", "Zeta"), host("m", "Mac mini"), host("a", "Air")], "m");
    expect(hosts.map((entry) => entry.id)).toEqual(["m", "a", "z"]);
  });
});

describe("plusAction", () => {
  it("has nothing to offer with no machine connected", () => {
    expect(plusAction([])).toEqual({ kind: "none" });
  });

  it("opens straight away on the only machine", () => {
    expect(plusAction([{ id: "m", name: "Mac mini" }])).toEqual({ kind: "open", hostId: "m" });
  });

  it("asks which machine when there are several", () => {
    const hosts = [
      { id: "m", name: "Mac mini" },
      { id: "a", name: "Air" },
    ];
    expect(plusAction(hosts)).toEqual({ kind: "ask", hosts });
  });
});
