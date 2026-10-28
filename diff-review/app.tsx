// diff-review — the app entry.
//
// A Review tab in each thread's side panel: the thread's diff with comment threads, sent to its
// agent; a button in the thread's header and palette commands that open it. See AGENTS.md.
import { definePluginApp, experimental_THREAD_INFO_ROW_GROUPS } from "@get-bb/plugin-sdk/app";

import { dispatchReviewCommand, REVIEW_COMMANDS, type ReviewCommand } from "./app/commands";
import { ReviewPanel } from "./app/review-panel";
import { REVIEWS_PATH, ReviewsPage, ReviewsSidebar, useReviewsBadge, useReviewsPageTitle } from "./app/reviews-page";
import { openReviewTab, REVIEW_TAB } from "./app/tab";
import { ReviewInfoRow } from "./app/thread-info";

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

  // Every review with comments, across projects, with the open ones counted on the sidebar entry.
  app.slots.navPanel({
    id: "reviews",
    title: "Reviews",
    icon: "FileDiff",
    path: REVIEWS_PATH,
    component: ReviewsPage,
    experimental_sidebar: ReviewsSidebar,
    experimental_usePageTitle: useReviewsPageTitle,
    experimental_useBadge: useReviewsBadge,
  });

  // "N open of M comment threads" in the thread's Info tab.
  app.slots.experimental_threadInfoRow({ id: "review", group: experimental_THREAD_INFO_ROW_GROUPS.git, component: ReviewInfoRow });

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

  // One command per action of the tab: each opens the thread's Review tab and does it there.
  for (const [id, title] of Object.entries(REVIEW_COMMANDS) as [ReviewCommand, string][]) {
    app.commands.register({
      id,
      title: `Diff Review: ${title}`,
      isAvailable: (context) => context.threadId !== null,
      run: (context) => {
        if (context.threadId === null) return;
        openReviewTab(context.experimental_panel);
        dispatchReviewCommand(context.threadId, id);
      },
    });
  }
});
