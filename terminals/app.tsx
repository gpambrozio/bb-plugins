// terminals — the app entry.
//
// One sidebar page, Terminals (app/terminals-page.tsx): tabs of shells on any
// machine connected to bb, each in that machine's home folder — and an
// invisible overlay that closes this copy's sockets when bb unloads it, and
// another that puts a selection sent with "Add to chat" into the chat's
// composer once that composer is on screen (app/chat-delivery.tsx).
import { useEffect } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { ChatDelivery } from "./app/chat-delivery";
import { releaseAllTerminals } from "./app/live-terminals";
import { PANEL_PATH, TerminalsPage } from "./app/terminals-page";

/**
 * Mounted once per window for as long as this copy of the app is loaded, and
 * rendering nothing: its unmount is the one sign that bb has reloaded or
 * disabled the plugin, when this copy's sockets must close.
 */
function TerminalsLifetime() {
  useEffect(() => releaseAllTerminals, []);
  return null;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "terminals",
    title: "Terminals",
    icon: "Terminal",
    path: PANEL_PATH,
    component: TerminalsPage,
  });

  app.slots.experimental_appOverlay({ id: "lifetime", component: TerminalsLifetime });
  app.slots.experimental_appOverlay({ id: "chat-delivery", component: ChatDelivery });
});
