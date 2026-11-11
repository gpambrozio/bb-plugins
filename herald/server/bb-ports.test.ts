/**
 * The thread context over a fake `bb.sdk`: the request a turn took in, read
 * from the event log, with the prompt history as the fallback when the log
 * cannot say.
 */
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

import { bbEvents } from "./bb-ports";
import { recordingLog, thread } from "./testing/fixtures";

function fakeSdk(eventRows: () => Promise<unknown[]>) {
  const list = vi.fn((_input: { threadId: string; types?: string[]; order?: string; limit?: string }) => eventRows());
  const promptHistory = vi.fn(async () => [{ id: "m1", createdAt: 1, input: [{ type: "text", text: "Run a review loop", mentions: [] }] }]);
  const sdk = {
    projects: { get: async () => ({ name: "Shop" }) },
    environments: { get: async () => ({ path: "/work/repo" }) },
    threads: { promptHistory, events: { list } },
  } as unknown as PluginBbSdk;
  return { sdk, list, promptHistory };
}

const childReport = [
  { seq: 9, type: "turn/input/accepted", data: { clientRequestId: "creq_child" } },
  {
    seq: 8,
    type: "client/turn/requested",
    data: { requestId: "creq_child", initiator: "system", input: [{ type: "text", text: "[bb system]\n\n@thread:thr_c completed:\n\nPass 1 is clean." }] },
  },
];

describe("bbEvents.context", () => {
  it("reads the turn's own message from the newest rows of the event log, one page under bb's limit", async () => {
    const { sdk, list } = fakeSdk(async () => childReport);
    const context = await bbEvents(sdk, recordingLog()).context(thread({ environmentId: "env1" }), { withRequest: true });
    expect(context).toEqual({
      projectName: "Shop",
      folder: "repo",
      lastRequest: "Run a review loop",
      turnRequest: "[bb system]\n\n@thread:thr_c completed:\n\nPass 1 is clean.",
    });
    const input = list.mock.calls[0]?.[0];
    expect(input).toMatchObject({ threadId: "t1", types: ["turn/input/accepted", "client/turn/requested"], order: "desc" });
    expect(Number(input?.limit)).toBeLessThanOrEqual(100);
  });

  it("leaves the turn's message out, with a warning, when the log cannot be read; the prompt history still answers", async () => {
    const log = recordingLog();
    const { sdk } = fakeSdk(async () => {
      throw new Error("HTTP 500");
    });
    const context = await bbEvents(sdk, log).context(thread(), { withRequest: true });
    expect(context.turnRequest).toBeNull();
    expect(context.lastRequest).toBe("Run a review loop");
    expect(log.lines.some((line) => line.startsWith("warn:") && line.includes("turn request") && line.includes("HTTP 500"))).toBe(true);
  });

  it("reads neither when the event needs no request", async () => {
    const { sdk, list, promptHistory } = fakeSdk(async () => childReport);
    const context = await bbEvents(sdk, recordingLog()).context(thread(), { withRequest: false });
    expect(context).toMatchObject({ lastRequest: null, turnRequest: null });
    expect(list).not.toHaveBeenCalled();
    expect(promptHistory).not.toHaveBeenCalled();
  });
});
