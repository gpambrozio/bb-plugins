// learning-exercises — the app entry.
//
// The offer banner above a thread's composer, the exercise card and its settled row in the transcript,
// the Learning tab in a thread's side panel (fixed in top-level threads, on demand in sub-agent
// threads), "Learning offers" in the thread menu, and the list of projects with no offers under the
// plugin's settings. See AGENTS.md.
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { CARD_RENDERER_ID } from "./shared/types";
import { OfferBanner } from "./app/banner";
import { ExerciseCard } from "./app/card";
import { NeverProjectsSection } from "./app/settings-section";
import { SettledRow } from "./app/settled-row";
import { LEARNING_FIXED_TAB, LEARNING_ON_DEMAND_TAB, LearningOnDemandTab, LearningTab, PLUGIN_ID, useLearningOnDemandVisible, useLearningTabVisible } from "./app/tab";
import { offersItem, useOffersData } from "./app/thread-action";

export default definePluginApp((app) => {
  app.composer.customize({ id: "offer", scopes: ["thread"], banners: [{ id: "offer", chrome: "card", component: OfferBanner }] });
  app.slots.pendingInteraction({ id: CARD_RENDERER_ID, component: ExerciseCard });
  app.slots.experimental_timelineRenderer({ kind: `${PLUGIN_ID}/${CARD_RENDERER_ID}`, component: SettledRow });
  app.slots.experimental_tab({
    ...LEARNING_FIXED_TAB,
    title: "Learning",
    icon: "Brain",
    layout: "padded",
    component: LearningTab,
    useVisible: useLearningTabVisible,
  });
  // The same tab on demand in the threads the fixed one skips (sub-agents, other plugins' threads): the
  // learner adds it from the side panel's launcher, and bb keeps it open with the thread. No offers there.
  // If the thread later qualifies for the fixed tab, `useOneLearningTab` closes the leftover instance.
  app.slots.experimental_tab({
    ...LEARNING_ON_DEMAND_TAB,
    title: "Learning",
    icon: "Brain",
    layout: "padded",
    component: LearningOnDemandTab,
    useVisible: useLearningOnDemandVisible,
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
