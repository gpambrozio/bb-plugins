import { describe, expect, it } from "vitest";

import { MAX_TAB_NAME, TabSchema, moveTab, normalizeTabName, tabLabels, tabStatus } from "./tabs";

let clock = 0;
/** A tab opened after every one made before it. */
const tab = (terminalId: string, hostId: string, hostName: string) => ({ terminalId, hostId, hostName, createdAt: ++clock });

describe("tabLabels", () => {
  it("names a machine's only tab after the machine", () => {
    const labels = tabLabels([tab("t1", "mini", "Mac mini"), tab("t2", "air", "MacBook Air")]);
    expect([...labels]).toEqual([
      ["t1", "Mac mini"],
      ["t2", "MacBook Air"],
    ]);
  });

  it("numbers a machine's tabs in opening order when it has several", () => {
    const labels = tabLabels([tab("t1", "mini", "Mac mini"), tab("t2", "air", "MacBook Air"), tab("t3", "mini", "Mac mini")]);
    expect(labels.get("t1")).toBe("Mac mini 1");
    expect(labels.get("t2")).toBe("MacBook Air");
    expect(labels.get("t3")).toBe("Mac mini 2");
  });

  it("shows a tab's own name, and keeps the others' numbers", () => {
    const labels = tabLabels([
      { ...tab("t1", "mini", "Mac mini"), name: "logs" },
      { ...tab("t2", "mini", "Mac mini"), name: null },
    ]);
    expect(labels.get("t1")).toBe("logs");
    expect(labels.get("t2")).toBe("Mac mini 2");
  });

  it("keeps each tab's number wherever the tab sits in the strip", () => {
    const first = tab("t1", "mini", "Mac mini");
    const second = tab("t2", "mini", "Mac mini");
    const labels = tabLabels([second, first]);
    expect(labels.get("t2")).toBe("Mac mini 2");
    expect(labels.get("t1")).toBe("Mac mini 1");
  });

  it("numbers tabs opened in the same millisecond alike in every order", () => {
    const a = { ...tab("term_a", "mini", "Mac mini"), createdAt: 5 };
    const b = { ...tab("term_b", "mini", "Mac mini"), createdAt: 5 };
    expect([...tabLabels([a, b])].sort()).toEqual([...tabLabels([b, a])].sort());
    expect(tabLabels([b, a]).get("term_a")).toBe("Mac mini 1");
  });

  it("falls back to Terminal for a machine with no name", () => {
    expect(tabLabels([tab("t1", "h", "  ")]).get("t1")).toBe("Terminal");
  });
});

describe("tabStatus", () => {
  it("passes a live session's status through", () => {
    expect(tabStatus({ status: "running" })).toBe("running");
    expect(tabStatus({ status: "starting" })).toBe("starting");
    expect(tabStatus({ status: "disconnected" })).toBe("disconnected");
  });

  it("calls an exited or unknown session ended", () => {
    expect(tabStatus({ status: "exited" })).toBe("ended");
    expect(tabStatus(null)).toBe("ended");
  });
});

describe("normalizeTabName", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeTabName("  dev \t server\n")).toBe("dev server");
  });

  it("turns an empty name into the default title", () => {
    expect(normalizeTabName("")).toBeNull();
    expect(normalizeTabName("   ")).toBeNull();
    expect(normalizeTabName(null)).toBeNull();
  });

  it("cuts a long name without splitting a character", () => {
    const cut = normalizeTabName("😀".repeat(MAX_TAB_NAME + 5))!;
    expect([...cut]).toHaveLength(MAX_TAB_NAME);
  });
});

describe("TabSchema", () => {
  it("reads a tab saved before tabs had names", () => {
    expect(TabSchema.parse({ terminalId: "t", hostId: "h", hostName: "Mac", createdAt: 1 }).name).toBeNull();
  });
});

describe("moveTab", () => {
  const list = ["a", "b", "c", "d"].map((terminalId) => ({ terminalId }));
  const ids = (tabs: readonly { terminalId: string }[]) => tabs.map((entry) => entry.terminalId);

  it("drops a tab moved right after the tab it was dropped on", () => {
    expect(ids(moveTab(list, "a", "c"))).toEqual(["b", "c", "a", "d"]);
  });

  it("drops a tab moved left before the tab it was dropped on", () => {
    expect(ids(moveTab(list, "d", "b"))).toEqual(["a", "d", "b", "c"]);
  });

  it("returns the same list when nothing moves", () => {
    expect(moveTab(list, "b", "b")).toBe(list);
    expect(moveTab(list, "gone", "b")).toBe(list);
    expect(moveTab(list, "b", "gone")).toBe(list);
  });
});
