// @vitest-environment jsdom
/** `useAppPanel` finds bb 0.48's hook in the runtime bb hands the bundle, and is null on bb 0.47. */
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const host = globalThis as { __bbPluginRuntime?: unknown };
const controller = { openTab: () => true };

async function load(exported: unknown, runtime: unknown) {
  vi.resetModules();
  vi.doMock("@get-bb/plugin-sdk/app", () => ({ experimental_useAppPanel: exported }));
  host.__bbPluginRuntime = runtime === undefined ? { pluginSdkApp: {} } : { pluginSdkApp: { experimental_useAppPanel: runtime } };
  const { useAppPanel } = await import("./app-panel");
  return renderHook(() => useAppPanel()).result.current;
}

afterEach(() => {
  vi.doUnmock("@get-bb/plugin-sdk/app");
  delete host.__bbPluginRuntime;
});

describe("useAppPanel", () => {
  it("asks bb's runtime, even for a bundle built against bb 0.47's exports", async () => {
    expect(await load(undefined, () => controller)).toBe(controller);
  });

  it("is null on bb 0.47, which has no panel controller", async () => {
    expect(await load(undefined, undefined)).toBeNull();
  });
});
