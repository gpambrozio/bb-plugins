/**
 * The server against the SDK's fake host: the settings bb's form draws, the layout RPCs, and the move of
 * a layout saved in the old setting.
 */
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import plugin from "./server";
import { LAYOUT_TAG } from "./shared/contract";
import { defaultLayout, serializeLayout, type Layout } from "./shared/layout";

const custom: Layout = { version: 1, folded: { buttons: [{ id: "f", label: "Forward", icon: "ArrowRight", action: { kind: "forward" } }] }, unfolded: { buttons: [] } };

async function start(values: Record<string, unknown> = {}) {
  const stored = { ...values };
  const { bb, harness } = createFakePluginHost({
    pluginId: "duo-rail",
    sdk: {
      plugins: {
        getSettings: async () => ({ ok: true, schema: {}, values: { ...stored } }) as never,
        updateSettings: async ({ values: changes }: { values: Record<string, unknown> }) => {
          for (const [key, value] of Object.entries(changes)) if (value === null) delete stored[key];
          return {} as never;
        },
      } as never,
    },
  });
  await plugin(bb);
  return { harness, stored };
}

describe("duo-rail server", () => {
  it("gives bb's settings form only the two camera gaps: the layout is not a setting", async () => {
    const { harness } = await start();
    expect(Object.keys(harness.registrations.settingsDescriptors)).toEqual(["cameraClearance", "cameraClearanceUnfolded"]);
  });

  it("answers the default layout, saves one, and invalidates every read", async () => {
    const { harness } = await start();
    expect(await harness.callRpc("layout.get", {})).toEqual({ layout: defaultLayout(), problem: null });
    expect(await harness.callRpc("layout.set", { layout: custom })).toEqual({ layout: custom });
    expect(harness.experimental_rpcInvalidations).toContainEqual([LAYOUT_TAG]);
    expect(await harness.callRpc("layout.get", {})).toEqual({ layout: custom, problem: null });
  });

  it("refuses a layout the rail could not draw", async () => {
    const { harness } = await start();
    await expect(harness.callRpc("layout.set", { layout: { ...custom, folded: { buttons: [{ id: "s", label: "Search", icon: "Search", action: { kind: "search" } }] } } })).rejects.toThrow();
  });

  it("moves a layout from the old setting on the first read, then drops the setting", async () => {
    const { harness, stored } = await start({ layout: serializeLayout(custom), cameraClearance: 180 });
    expect(await harness.callRpc("layout.get", {})).toEqual({ layout: custom, problem: null });
    expect(stored).toEqual({ cameraClearance: 180 });
  });
});
