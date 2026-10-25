// diff-review — the app entry.
//
// A Review tab in each thread's side panel: the thread's diff with comment threads, sent to its
// agent; a button in the thread's title bar and a palette command that open it. See AGENTS.md.
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { ReviewHeaderAction } from "./app/header-action";
import { PANEL_ACTION_ID, ReviewPanel } from "./app/review-panel";

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Review",
    icon: "FileDiff",
    layout: "flush",
    component: ReviewPanel,
  });

  // And a button in the thread's title bar that opens it, beside bb's own actions.
  app.slots.experimental_threadHeaderAction({ id: PANEL_ACTION_ID, title: "Review", component: ReviewHeaderAction });

  // No default key: bb owns the obvious ones (Mod+D is its own diff panel), and a default that
  // clashes is left unbound anyway. Settings binds it.
  app.commands.register({
    id: "open",
    title: "Diff Review: review this thread's changes",
    isAvailable: (context) => context.threadId !== null,
    run: (context) => {
      context.openPanel({ actionId: PANEL_ACTION_ID });
    },
  });
});
