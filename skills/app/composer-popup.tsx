/**
 * The Skills list in bb's own composer popup, opened by the composer button
 * and by the "browse skills" composer command. bb places it above or below the
 * composer as it does the mention menu, uses a drawer on a narrow window,
 * closes it on Escape or a click outside, and gives the editor its focus back
 * when it closes. Inside it, `useComposer()` is the composer that opened it.
 *
 * A button at the top opens the full panel, on the skill being shown if any.
 */
import { useBbNavigate, useComposer } from "@get-bb/plugin-sdk/app";
import { type MouseEvent, useCallback, useRef } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { type Selection, SkillBrowser } from "./browser";
import { PANEL_ACTION_ID } from "./panel";
import { useSkillList } from "./use-skills";

/** The popup's id in this plugin's composer customization. */
export const SKILLS_POPUP_ID = "skills";

/**
 * Opens the Skills popup in `composer`, or closes it if it is already open
 * there, so the button and the shortcut both toggle it.
 */
export function toggleSkillsPopup(composer: {
  experimental_openPopup(popupId: string): boolean;
  experimental_closePopup(): boolean;
}): void {
  if (composer.experimental_closePopup()) return;
  if (!composer.experimental_openPopup(SKILLS_POPUP_ID)) {
    toast.error("The Skills list opens only in a thread's own message box.");
  }
}

/**
 * bb draws the popup inside the composer's form, and a press anywhere in that
 * form that is not on a control moves the focus to the editor — which closes
 * the popup. Kept here, a press on the list's text, a skill's body or the
 * scroll bar leaves the popup open, as the popover it replaced did.
 */
function keepPressInPopup(event: MouseEvent) {
  event.stopPropagation();
}

export function SkillsPopup() {
  const { scope } = useComposer();
  if (scope.kind !== "thread") return null;
  return <SkillsPopupContent threadId={scope.threadId} />;
}

function SkillsPopupContent({ threadId }: { threadId: string }) {
  // Mounted each time the popup opens, so each opening scans again; the
  // button's count follows, through the shared list.
  const { state } = useSkillList(threadId);
  const navigate = useBbNavigate();
  const composer = useComposer();

  // The skill whose detail the popup shows, if any: **Open in panel** opens
  // the tab on it, as a tab of its own named after it.
  const selection = useRef<Selection | null>(null);
  const handleSelectionChange = useCallback((next: Selection | null) => {
    selection.current = next;
  }, []);

  function panelOptions() {
    const skill = selection.current;
    if (skill === null) return { actionId: PANEL_ACTION_ID };
    const name =
      skill.kind === "reported"
        ? skill.name
        : state.status === "ready"
          ? state.data.skills.find((entry) => entry.id === skill.id)?.name
          : undefined;
    return { actionId: PANEL_ACTION_ID, title: name === undefined ? "Skills" : `Skills: ${name}`, params: { skill } };
  }

  function openPanel() {
    const options = panelOptions();
    composer.experimental_closePopup();
    if (!navigate.openThreadPanel(options)) {
      toast.error("This view has no side panel. Open the thread itself to see the Skills panel.");
    }
  }

  return (
    <div className="flex max-h-[min(32rem,70vh)] flex-col" onMouseDown={keepPressInPopup}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-medium text-foreground">Skills</span>
        <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={openPanel}>
          Open in panel
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* The composer under this popup is already the thread's, so after
            Add to chat the popup only has to close; bb gives the editor its
            focus back as it does. */}
        <SkillBrowser
          threadId={threadId}
          frame="popup"
          list={state}
          onSelectionChange={handleSelectionChange}
          onAdded={() => composer.experimental_closePopup()}
        />
      </div>
    </div>
  );
}
