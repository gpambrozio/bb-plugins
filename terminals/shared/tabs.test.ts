import { describe, expect, it } from "vitest";

import { tabLabels, tabStatus } from "./tabs";

const tab = (terminalId: string, hostId: string, hostName: string) => ({ terminalId, hostId, hostName });

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
