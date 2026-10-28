/**
 * The thread header's way into the thread's Herald tab, the list of what
 * Herald said about its past turns.
 *
 * It is the megaphone of the older header slot on every bb, an icon button of
 * its own. bb 0.48's header thread actions (`placement: "header"`) would make
 * it a labelled button, but bb draws every plugin's header actions as one
 * split button — the first the main action, the rest in its dropdown — so
 * Herald would share a control with Diff Review's Review or bb's Commit. On
 * bb 0.48 the megaphone opens the tab, or closes it when it is already
 * showing, through the panel controller; bb 0.47 has none, so there it opens
 * the tab by its id.
 */
import { useBbNavigate, type ExperimentalOpenTabOptions, type PluginAppSlots } from "@get-bb/plugin-sdk/app";

import { Icon } from "@/components/ui/icon";

import { useAppPanel } from "./bb-features";
import { HERALD_ICONS } from "./icons";
import { TipButton } from "./tip-button";

/** The id of the thread tab this button opens (`experimental_tab`); registered in `app.tsx`. */
export const HISTORY_PANEL_ACTION_ID = "history";

/** The Herald tab, as the panel controller names it. */
export const HISTORY_TAB: ExperimentalOpenTabOptions = {
  tab: { id: HISTORY_PANEL_ACTION_ID, context: { kind: "thread" }, availability: "action" },
};

/** The megaphone. One 28px control, as the header slot asks. */
function MegaphoneButton({ onClick }: { onClick: () => void }) {
  return (
    <TipButton variant="ghost" size="icon" className="size-7" label="Herald: this thread's sentences" onClick={onClick}>
      <Icon name={HERALD_ICONS.megaphone} />
    </TipButton>
  );
}

/** bb 0.48: the megaphone toggles the Herald tab of the thread whose header it is in. */
export function HeraldHeaderToggle(_props: { threadId: string }) {
  const panel = useAppPanel();
  return <MegaphoneButton onClick={() => void panel.toggleTab(HISTORY_TAB)} />;
}

/** bb 0.47: the megaphone opens the Herald tab by its id. */
export function HeraldHeaderAction(_props: { threadId: string }) {
  const navigate = useBbNavigate() as unknown as LegacyNavigate;
  return <MegaphoneButton onClick={() => void navigate.openThreadPanel({ actionId: HISTORY_PANEL_ACTION_ID })} />;
}

/**
 * The megaphone in the older header slot, which bb 0.48 still draws as its
 * own button: toggling through the panel controller where bb has one (0.48),
 * opening by id otherwise.
 */
export function registerHistoryOpener(slots: PluginAppSlots, hasPanelController: boolean): void {
  (slots as unknown as LegacySlots).experimental_threadHeaderAction({
    id: HISTORY_PANEL_ACTION_ID,
    title: "Herald",
    component: hasPanelController ? HeraldHeaderToggle : HeraldHeaderAction,
  });
}

/** The older header slot, gone from the SDK's types since 0.6.92 and retired, still drawn, in bb 0.48. */
interface LegacySlots {
  experimental_threadHeaderAction(registration: { id: string; title: string; component: typeof HeraldHeaderAction }): void;
}

/** bb 0.47's way to open a thread tab, gone from the SDK's types since 0.6.88. */
interface LegacyNavigate {
  openThreadPanel(options: { actionId: string }): boolean | Promise<boolean>;
}
