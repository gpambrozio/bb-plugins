/**
 * The megaphone in a thread's header: opens the thread's Herald panel, the
 * list of what Herald said about its past turns. One 28px control, as the
 * host asks of a header action; the panel does the rest.
 */
import { useBbNavigate } from "@get-bb/plugin-sdk/app";

import { Icon } from "@/components/ui/icon";

import { HERALD_ICONS } from "./icons";
import { TipButton } from "./tip-button";

/** The `threadPanelAction` id this button opens; registered in `app.tsx`. */
export const HISTORY_PANEL_ACTION_ID = "history";

export function HeraldHeaderAction(_props: { threadId: string }) {
  const navigate = useBbNavigate();
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
