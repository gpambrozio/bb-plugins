/** The server against the SDK's fake host: what it stores, announces and refuses. */
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import plugin, { PHONE_LAYOUT_KEY } from "./server";
import { LAYOUT_CHANGED_CHANNEL } from "./shared/layout";

async function start() {
  const host = createFakePluginHost({ pluginId: "phone-rail" });
  await plugin(host.bb);
  return host;
}

const LAYOUT = { visible: ["board/board"], order: ["board/board", "__bb__/extensions"] };

describe("phone layout", () => {
  it("is null until a phone saves one", async () => {
    const { harness } = await start();
    expect(await harness.callRpc("getPhoneLayout", {})).toEqual({ layout: null });
  });

  it("is stored, announced, and kept across a reload", async () => {
    const { bb, harness } = await start();
    await harness.callRpc("setPhoneLayout", { layout: LAYOUT });

    expect(await bb.storage.kv.get(PHONE_LAYOUT_KEY)).toEqual(LAYOUT);
    expect(harness.realtimeSignals).toEqual([{ channel: LAYOUT_CHANGED_CHANNEL, payload: { layout: LAYOUT } }]);

    const next = (await harness.reload(plugin)).harness;
    expect(await next.callRpc("getPhoneLayout", {})).toEqual({ layout: LAYOUT });
  });

  it("goes back to bb's shared preferences when cleared", async () => {
    const { bb, harness } = await start();
    await harness.callRpc("setPhoneLayout", { layout: LAYOUT });
    await harness.callRpc("setPhoneLayout", { layout: null });

    expect(await bb.storage.kv.get(PHONE_LAYOUT_KEY)).toBeUndefined();
    expect(await harness.callRpc("getPhoneLayout", {})).toEqual({ layout: null });
    expect(harness.realtimeSignals.at(-1)).toEqual({ channel: LAYOUT_CHANGED_CHANNEL, payload: { layout: null } });
  });

  it("reads an unreadable stored layout as none, and says so in the log", async () => {
    const { bb, harness } = await start();
    await bb.storage.kv.set(PHONE_LAYOUT_KEY, { visible: "everything" });

    expect(await harness.callRpc("getPhoneLayout", {})).toEqual({ layout: null });
    expect(harness.logEntries.map((entry) => entry.message).join("\n")).toMatch(/unreadable phone layout/);
  });

  it("refuses a malformed layout", async () => {
    const { harness } = await start();
    await expect(harness.callRpc("setPhoneLayout", { layout: { visible: [""], order: [] } })).rejects.toThrow();
  });
});
