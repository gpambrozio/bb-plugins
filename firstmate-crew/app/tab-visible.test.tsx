// @vitest-environment jsdom
/**
 * `useTabVisible` finds bb 0.48's hook in the runtime bb hands the bundle, whatever list of the SDK's
 * exports the bundle was built against, and counts the tab as shown where there is none. `built-bundle.test`
 * runs the same against the bundle bb built.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const host = globalThis as { __bbPluginRuntime?: unknown };

async function load(exported: (() => boolean) | undefined, runtime: (() => boolean) | undefined) {
  vi.resetModules();
  vi.doMock("@get-bb/plugin-sdk/app", () => ({ experimental_useTabVisible: exported }));
  host.__bbPluginRuntime = runtime === undefined ? { pluginSdkApp: {} } : { pluginSdkApp: { experimental_useTabVisible: runtime } };
  const { useTabVisible } = await import("./tab-visible");
  return renderHook(() => useTabVisible()).result.current;
}

afterEach(() => {
  vi.doUnmock("@get-bb/plugin-sdk/app");
  delete host.__bbPluginRuntime;
});

describe("useTabVisible", () => {
  it("asks bb's runtime where it has the hook", async () => {
    expect(await load(() => true, () => false)).toBe(false);
  });

  it("asks bb's runtime even when the bundle was built against bb 0.47's exports, which lack it", async () => {
    expect(await load(undefined, () => false)).toBe(false);
  });

  it("is true on bb 0.47, which has no such hook", async () => {
    expect(await load(undefined, undefined)).toBe(true);
  });
});
