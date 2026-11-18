// phone-rail — the server entry.
//
// Keeps the phone layout (which rail destinations a phone-sized screen shows,
// and in what order) in the plugin's storage on the bb server, so every phone
// and every narrow window shares it and it survives restarts. It announces
// each change on a realtime channel so open windows redraw at once. Drawing
// the rail is the app's job (app.tsx).
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { rpcContract } from "./shared/contract";
import { LAYOUT_CHANGED_CHANNEL, NavigationLayoutSchema, type NavigationLayout } from "./shared/layout";

export type { RpcContract } from "./shared/contract";

/** The storage key, named for the form factor it serves: the SDK names no client or device. */
export const PHONE_LAYOUT_KEY = "layout.compact";

export default async function plugin(bb: BbPluginApi) {
  async function load(): Promise<NavigationLayout | null> {
    const stored = await bb.storage.kv.get<unknown>(PHONE_LAYOUT_KEY);
    if (stored === undefined || stored === null) return null;
    const parsed = NavigationLayoutSchema.safeParse(stored);
    if (!parsed.success) {
      bb.log.warn(`ignoring an unreadable phone layout: ${parsed.error.message}`);
      return null;
    }
    return parsed.data;
  }

  bb.rpc.register(rpcContract, {
    getPhoneLayout: async () => ({ layout: await load() }),
    setPhoneLayout: async ({ layout }) => {
      if (layout === null) await bb.storage.kv.delete(PHONE_LAYOUT_KEY);
      else await bb.storage.kv.set(PHONE_LAYOUT_KEY, layout);
      bb.realtime.publish(LAYOUT_CHANGED_CHANNEL, { layout });
      return {};
    },
  });
}
