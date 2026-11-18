/**
 * The side panel of the view a component renders in (`experimental_useAppPanel`, bb 0.48), or null on a
 * bb without it. The first-run guide opens the FirstMate tab through it (`intro.tsx`, `BoardOpener`).
 *
 * Looked up when the bundle runs, from the runtime bb hands it, for the reason `tab-visible.ts` gives: bb
 * 0.47 refuses a bundle with a named import of a hook it lacks. On bb 0.47 the guide still opens the first
 * mate's thread, and the captain opens the tab from its panel. Which applies is fixed when the module
 * loads, so the hooks a component calls never change.
 */
import * as bbApp from "@get-bb/plugin-sdk/app";
import type { ExperimentalPanelController } from "@get-bb/plugin-sdk/app";

type AppPanelHook = () => ExperimentalPanelController;

interface PluginRuntime {
  pluginSdkApp?: { experimental_useAppPanel?: unknown };
}

function lookUpHook(): AppPanelHook | undefined {
  const runtime = (globalThis as { __bbPluginRuntime?: PluginRuntime }).__bbPluginRuntime;
  const fromRuntime = runtime?.pluginSdkApp?.experimental_useAppPanel;
  if (typeof fromRuntime === "function") return fromRuntime as AppPanelHook;
  // In tests, with no runtime installed when this loads, the SDK's own export.
  return (bbApp as Partial<typeof bbApp>).experimental_useAppPanel;
}

const appPanelHook = lookUpHook();

export function useAppPanel(): ExperimentalPanelController | null {
  return appPanelHook === undefined ? null : appPanelHook();
}
