import { describe, expect, it } from "vitest";

import { hostRows, projectRows } from "./rows";

describe("project rows", () => {
  it("are one per name: same-named projects share a row", () => {
    const rows = projectRows([{ name: "FirstMate" }, { name: "Gallager" }, { name: "FirstMate" }, { name: "Acme" }, { name: "Gallager" }]);
    expect(rows).toEqual([
      { key: "Acme", label: "Acme" },
      { key: "FirstMate", label: "FirstMate" },
      { key: "Gallager", label: "Gallager" },
    ]);
  });
});

describe("machine rows", () => {
  it("are sorted by name, once per machine", () => {
    const hosts = [
      { id: "host_mini", name: "MacMini" },
      { id: "host_mbp", name: "MacBook Pro" },
    ];
    expect(hostRows([...hosts, hosts[0]!])).toEqual([
      { key: "host_mbp", label: "MacBook Pro" },
      { key: "host_mini", label: "MacMini" },
    ]);
  });
});
