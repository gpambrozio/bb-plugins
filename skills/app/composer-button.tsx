/**
 * The Skills button in a thread's composer, with a live count, opening a
 * popover over the composer that lists the thread's skills and runs one; a
 * button in the popover opens the full panel. On a narrow window the vendored
 * popover is a bottom sheet instead.
 *
 * The count is the browser's own list, held here and handed to the popover, so
 * opening it costs no second scan. It is asked for when the button mounts and
 * again each time the popover opens; the button shows `Skills` without a
 * number until the first answer, rather than a `Skills 0` that then jumps.
 */
import { useBbNavigate, useComposer, useComposerView } from "@get-bb/plugin-sdk/app";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import { countEntries } from "../shared/skills";
import { SkillBrowser } from "./browser";
import { SKILLS_ICON } from "./icons";
import { PANEL_ACTION_ID } from "./panel";
import { useSkillList } from "./use-skills";

export function SkillsComposerButton() {
  const view = useComposerView();
  if (view.scope.kind !== "thread") return null;
  return <SkillsButton threadId={view.scope.threadId} />;
}

function SkillsButton({ threadId }: { threadId: string }) {
  const { state, reload } = useSkillList(threadId);
  const [open, setOpen] = useState(false);
  const navigate = useBbNavigate();
  const composer = useComposer();
  // After **Add to chat** the composer gets the focus back, rather than the
  // popover handing it to this button as it closes. On a wide window that is
  // Radix's close-focus, which can be stopped; on a narrow one it is the
  // drawer's, which restores focus as it closes, so the composer takes it
  // once the drawer has finished closing.
  const added = useRef(false);
  function focusComposerAfterAdd(): boolean {
    if (!added.current) return false;
    added.current = false;
    composer.focus();
    return true;
  }
  const count = state.status === "ready" ? countEntries(state.data) : null;

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) reload();
  }

  function openPanel() {
    setOpen(false);
    if (!navigate.openThreadPanel({ actionId: PANEL_ACTION_ID })) {
      toast.error("This view has no side panel. Open the thread itself to see the Skills panel.");
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 px-2 text-muted-foreground"
          aria-label={count === null ? "Skills" : `Skills: ${count}`}
        >
          <Icon name={SKILLS_ICON} aria-hidden />
          Skills
          {count === null ? null : <span className="tabular-nums">{count}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        mobileTitle="Skills"
        className="flex max-h-[min(32rem,70vh)] w-[min(28rem,calc(100vw-2rem))] flex-col p-0"
        onCloseAutoFocus={(event) => {
          if (focusComposerAfterAdd()) event.preventDefault();
        }}
        onMobileContentAnimationEnd={(isOpen) => {
          if (!isOpen) focusComposerAfterAdd();
        }}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <span className="text-sm font-medium text-foreground">Skills</span>
          <Button variant="link" size="sm" className="h-auto px-0" onClick={openPanel}>
            Open in panel
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* The composer under this popover is already the thread's, so after
              Add to chat the popover only has to get out of the way. */}
          <SkillBrowser
            threadId={threadId}
            frame="popover"
            list={state}
            onAdded={() => {
              added.current = true;
              setOpen(false);
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
