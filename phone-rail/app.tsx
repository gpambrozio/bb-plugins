// phone-rail — the app entry.
//
// A navigation provider for bb's sidebar: bb's own Rail, except that a
// compact (phone-sized) screen keeps its own set of rail icons and their
// order. Pick it in Settings → Appearance → Navigation, or
// `bb settings ui set sidebar.navigationProvider phone-rail/rail`. See AGENTS.md.
import type { ExperimentalSidebarNavigationProps } from "@get-bb/plugin-sdk/app";
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { Rail as RailBody, RailNewThreadButton } from "./app/bb-rail/Rail";
import { PhoneEditor } from "./app/phone-editor";
import { RailPreferencesProvider } from "./app/rail-preferences";

export function Rail({ isCompactViewport }: ExperimentalSidebarNavigationProps) {
  return (
    <RailPreferencesProvider isCompactViewport={isCompactViewport}>
      <RailBody />
      <PhoneEditor />
    </RailPreferencesProvider>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_sidebarNavigation({
    id: "rail",
    title: "Phone Rail",
    description: "bb's icon rail, with its own set of icons on phones",
    placement: "rail",
    component: Rail,
    headerComponent: RailNewThreadButton,
  });
});
