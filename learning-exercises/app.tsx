// learning-exercises — the app entry.
//
// The offer banner above a thread's composer, the exercise card and its settled row in the transcript,
// the Learning tab in a thread's side panel, "Learning offers" in the thread menu, and the list of
// projects with no offers under the plugin's settings. See AGENTS.md.
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { CARD_RENDERER_ID } from "./shared/types";
import { OfferBanner } from "./app/banner";
import { ExerciseCard } from "./app/card";
import { NeverProjectsSection } from "./app/settings-section";
import { SettledRow } from "./app/settled-row";
import { LearningTab, PLUGIN_ID, useLearningTabVisible } from "./app/tab";
import { offersItem, useOffersData } from "./app/thread-action";

export default definePluginApp((app) => {
  app.composer.customize({ id: "offer", scopes: ["thread"], banners: [{ id: "offer", chrome: "card", component: OfferBanner }] });
  app.slots.pendingInteraction({ id: CARD_RENDERER_ID, component: ExerciseCard });
  app.slots.experimental_timelineRenderer({ kind: `${PLUGIN_ID}/${CARD_RENDERER_ID}`, component: SettledRow });
  app.slots.experimental_tab({
    id: "learning",
    context: { kind: "thread" },
    availability: "fixed",
    title: "Learning",
    icon: "Brain",
    layout: "padded",
    component: LearningTab,
    useVisible: useLearningTabVisible,
  });
  app.slots.experimental_threadAction({
    id: "offers",
    title: "Learning offers",
    icon: "Brain",
    group: "learning-exercises",
    useData: useOffersData,
    item: offersItem,
  });
  app.slots.settingsSection({ id: "never-projects", component: NeverProjectsSection });
});
