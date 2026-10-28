/**
 * Whether the FirstMate tab can be seen: bb keeps a closed panel's tabs mounted, so the board asks before
 * it reads. `experimental_useTabVisible` is bb 0.48's. bb builds a plugin's app against its own list of
 * the SDK's exports, so bb 0.47 refuses to build a named import of it; read through the namespace, it is
 * simply absent there, and the board reads as it did before 0.48, whether it can be seen or not. Which
 * one applies is fixed when the module loads, so the hooks a component calls never change between renders.
 */
import * as bbApp from "@get-bb/plugin-sdk/app";

const tabVisibleHook: (() => boolean) | undefined = (bbApp as Partial<typeof bbApp>).experimental_useTabVisible;

export function useTabVisible(): boolean {
  return tabVisibleHook === undefined ? true : tabVisibleHook();
}
