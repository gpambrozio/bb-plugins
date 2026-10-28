/**
 * The thread header's way into the thread's Herald tab, the list of what
 * Herald said about its past turns.
 *
 * On bb 0.48 it is a header thread action: a labelled "Herald" button after
 * the workspace's Open button, folded into the header's thread menu at compact
 * width, that opens the tab — or closes it, when it is already showing —
 * through the panel controller. bb 0.47 has neither, and drops `placement`
 * (the button would land in every thread menu), so there it stays the
 * megaphone of the older header slot, which opens the tab by its id.
 */
import {
  experimental_THREAD_ACTION_GROUPS,
  useBbNavigate,
  type ExperimentalOpenTabOptions,
  type PluginAppSlots,
  type PluginThreadActionRegistration,
} from "@get-bb/plugin-sdk/app";

import { Icon } from "@/components/ui/icon";

import { HERALD_ICONS } from "./icons";
import { TipButton } from "./tip-button";

/** The id of the thread tab this button opens (`experimental_tab`); registered in `app.tsx`. */
export const HISTORY_PANEL_ACTION_ID = "history";

/** The Herald tab, as the panel controller names it. */
export const HISTORY_TAB: ExperimentalOpenTabOptions = {
  tab: { id: HISTORY_PANEL_ACTION_ID, context: { kind: "thread" }, availability: "action" },
};

/** bb 0.48's header button: "Herald", toggling the thread's Herald tab. */
export const HISTORY_HEADER_ACTION: PluginThreadActionRegistration = {
  id: "history",
  title: "Herald",
  icon: HERALD_ICONS.megaphone,
  group: experimental_THREAD_ACTION_GROUPS.open,
  placement: "header",
  item: ({ experimental_panel }) => ({
    label: "Herald",
    icon: HERALD_ICONS.megaphone,
    run: () => {
      experimental_panel.toggleTab(HISTORY_TAB);
    },
  }),
};

/** bb 0.47's megaphone in the header slot. One 28px control, as the slot asks. */
export function HeraldHeaderAction(_props: { threadId: string }) {
  const navigate = useBbNavigate() as unknown as LegacyNavigate;
  return (
    <TipButton
      variant="ghost"
      size="icon"
      className="size-7"
      label="Herald: this thread's sentences"
      onClick={() => void navigate.openThreadPanel({ actionId: HISTORY_PANEL_ACTION_ID })}
    >
      <Icon name={HERALD_ICONS.megaphone} />
    </TipButton>
  );
}

/**
 * The header button that fits this bb: the header thread action where bb has
 * the panel controller (0.48), the older header slot otherwise. bb 0.48 still
 * draws that slot, so registering both would show two.
 */
export function registerHistoryOpener(slots: PluginAppSlots, hasPanelController: boolean): void {
  if (hasPanelController) {
    slots.experimental_threadAction(HISTORY_HEADER_ACTION);
  } else {
    (slots as unknown as LegacySlots).experimental_threadHeaderAction({
      id: HISTORY_PANEL_ACTION_ID,
      title: "Herald",
      component: HeraldHeaderAction,
    });
  }
}

/** bb 0.47's header slot, gone from the SDK's types since 0.6.92. */
interface LegacySlots {
  experimental_threadHeaderAction(registration: { id: string; title: string; component: typeof HeraldHeaderAction }): void;
}

/** bb 0.47's way to open a thread tab, gone from the SDK's types since 0.6.88. */
interface LegacyNavigate {
  openThreadPanel(options: { actionId: string }): boolean | Promise<boolean>;
}
