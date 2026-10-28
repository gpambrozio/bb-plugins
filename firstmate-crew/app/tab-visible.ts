/**
 * Whether the FirstMate tab can be seen: bb keeps a closed panel's tabs mounted, so the board asks before
 * it reads. `experimental_useTabVisible` is bb 0.48's.
 *
 * It is looked up when the bundle runs, not when it is built. bb builds a plugin's app against its own
 * list of the SDK's exports: bb 0.47 refuses a named import of a hook it lacks, and resolves a namespace
 * read of one to nothing in the bundle. A git install is built once, by the bb it was installed on, and
 * keeps that bundle after bb is upgraded, so a bundle built by bb 0.47 must still find the hook on bb 0.48.
 * Every bundle reads the SDK's app members from `globalThis.__bbPluginRuntime.pluginSdkApp`, the runtime bb
 * hands it (bb's build emits that read, and the SDK's own forwarders make it); this reads the hook from
 * the same place. Where it is absent (bb 0.47) the board reads whether it can be seen or not, as it did
 * before. Which applies is fixed when the module loads, so the hooks a component calls never change.
 */
import * as bbApp from "@get-bb/plugin-sdk/app";

type TabVisibleHook = () => boolean;

interface PluginRuntime {
  pluginSdkApp?: { experimental_useTabVisible?: unknown };
}

function lookUpHook(): TabVisibleHook | undefined {
  const runtime = (globalThis as { __bbPluginRuntime?: PluginRuntime }).__bbPluginRuntime;
  const fromRuntime = runtime?.pluginSdkApp?.experimental_useTabVisible;
  if (typeof fromRuntime === "function") return fromRuntime as TabVisibleHook;
  // In tests, with no runtime installed when this loads, the SDK's own export.
  return (bbApp as Partial<typeof bbApp>).experimental_useTabVisible;
}

const tabVisibleHook = lookUpHook();

export function useTabVisible(): boolean {
  return tabVisibleHook === undefined ? true : tabVisibleHook();
}
