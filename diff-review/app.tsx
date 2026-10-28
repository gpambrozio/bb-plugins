// diff-review — the app entry.
//
// A Review tab in each thread's side panel: the thread's diff with comment threads, sent to its
// agent; a button in the thread's header and palette commands that open it. See AGENTS.md.
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { ReviewPanel } from "./app/review-panel";
import { openReviewTab, REVIEW_TAB } from "./app/tab";

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    ...REVIEW_TAB,
    title: "Review",
    icon: "FileDiff",
    tooltip: "Review this thread's changes",
    layout: "flush",
    component: ReviewPanel,
  });

  // A "Review" button in the thread's header, after bb's Open; it folds into the thread menu when
  // the header is narrow.
  app.slots.experimental_threadAction({
    id: "review",
    title: "Review",
    icon: "FileDiff",
    group: "diff-review",
    placement: "header",
    item: ({ experimental_panel }) => ({
      label: "Review",
      detail: "Review this thread's changes",
      icon: "FileDiff",
      run: () => {
        openReviewTab(experimental_panel);
      },
    }),
  });

  // No default key: bb owns the obvious ones (Mod+D is its own diff panel), and a default that
  // clashes is left unbound anyway. Settings binds it.
  app.commands.register({
    id: "open",
    title: "Diff Review: review this thread's changes",
    isAvailable: (context) => context.threadId !== null,
    run: (context) => {
      openReviewTab(context.experimental_panel);
    },
  });
});
