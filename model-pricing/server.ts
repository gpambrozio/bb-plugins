// model-pricing — the server entry.
//
// One RPC, `load`, answered from a cache on `bb.storage.kv` or the network
// (server/pricing.ts), and the settings form bb renders. The server reads no
// setting: the app sends the providers it wants with every call. See AGENTS.md.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { PricingCache } from "./server/cache";
import { createPricingHandler } from "./server/pricing";
import { DEFAULT_DEPS } from "./server/sources";
import { rpcContract } from "./shared/contract";
import { SETTINGS } from "./shared/settings";

export type { RpcContract } from "./shared/contract";

export default async function plugin(bb: BbPluginApi) {
  // Registering the definitions is what makes bb render the form and hand the
  // values to the app's `useSettings()`.
  bb.settings.define(SETTINGS);

  const warn = (message: string) => bb.log.warn(message);
  const cache = new PricingCache(bb.storage.kv, warn);
  const disposed = new AbortController();
  const load = createPricingHandler(cache, { ...DEFAULT_DEPS, signal: disposed.signal }, warn);

  bb.rpc.register(rpcContract, { load });

  // A reload loads the new instance before this one is disposed. Fetches still
  // in flight here are aborted, and any answer that lands anyway is not
  // written: after dispose this instance's storage handle is stale. The new
  // instance refetches what it does not find.
  bb.onDispose(() => {
    disposed.abort();
    return cache.close();
  });
}
