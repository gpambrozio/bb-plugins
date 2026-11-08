// learning-exercises — the app entry.
//
// The offer banner above a thread's composer, the exercise card and its settled row in the transcript,
// the agent's feedback as a card above its turn's last message, the Learning tab on the tab bar of every listed thread's side panel, "Learning offers" in the thread menu, and the list of projects with no offers under the
// plugin's settings. See AGENTS.md.
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { CARD_RENDERER_ID } from "./shared/types";
import { OfferBanner } from "./app/banner";
import { ExerciseCard } from "./app/card";
import { FEEDBACK_METADATA_ID, FeedbackAboveMessage } from "./app/feedback";
import { ORIENTATION_TAB_ID } from "./app/orientation-ids";
import { OrientationTab } from "./app/orientation-tab";
import { NeverProjectsSection } from "./app/settings-section";
import { SettledRow } from "./app/settled-row";
import { LEARNING_FIXED_TAB, LEARNING_ON_DEMAND_TAB, LearningOnDemandTab, LearningTab, PLUGIN_ID, useLearningOnDemandVisible, useLearningTabVisible } from "./app/tab";
import { offersItem, useOffersData } from "./app/thread-action";

export default definePluginApp((app) => {
  app.composer.customize({ id: "offer", scopes: ["thread"], banners: [{ id: "offer", chrome: "card", component: OfferBanner }] });
  app.slots.pendingInteraction({ id: CARD_RENDERER_ID, component: ExerciseCard });
  app.slots.experimental_timelineRenderer({ kind: `${PLUGIN_ID}/${CARD_RENDERER_ID}`, component: SettledRow });
  app.slots.experimental_messageMetadata({ id: FEEDBACK_METADATA_ID, placement: "above", component: FeedbackAboveMessage });
  app.slots.experimental_tab({
    ...LEARNING_FIXED_TAB,
    title: "Learning",
    icon: "Brain",
    layout: "padded",
    component: LearningTab,
    useVisible: useLearningTabVisible,
  });
  // Retired: earlier builds offered the tab in sub-agent threads only from the launcher, as an action tab.
  // bb keeps those instances with the thread, so the registration stays to render and close them
  // (`useOneLearningTab`); it is never offered in the launcher again.
  app.slots.experimental_tab({
    ...LEARNING_ON_DEMAND_TAB,
    title: "Learning",
    icon: "Brain",
    layout: "padded",
    component: LearningOnDemandTab,
    useVisible: useLearningOnDemandVisible,
  });
  app.slots.experimental_tab({
    id: ORIENTATION_TAB_ID,
    context: { kind: "thread" },
    availability: "action",
    title: "Walkthrough",
    icon: "FileText",
    layout: "padded",
    component: OrientationTab,
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
