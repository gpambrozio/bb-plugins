/**
 * The Skills button in a thread's composer, with a live count, opening the
 * Skills list in bb's composer popup (`./composer-popup`).
 *
 * The count is asked for when the button mounts; each time the popup opens it
 * scans again and the count follows, through the list the two share. The button
 * shows `Skills` without a number until the first answer, rather than a
 * `Skills 0` that then jumps.
 *
 * `type="button"`: the button sits in the composer's form, where a button with
 * no type would send the message.
 */
import { useComposer } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

import { countEntries } from "../shared/skills";
import { toggleSkillsPopup } from "./composer-popup";
import { SKILLS_ICON } from "./icons";
import { useSkillList } from "./use-skills";

export function SkillsComposerButton() {
  const { scope } = useComposer();
  if (scope.kind !== "thread") return null;
  return <SkillsButton threadId={scope.threadId} />;
}

function SkillsButton({ threadId }: { threadId: string }) {
  const { state } = useSkillList(threadId);
  const composer = useComposer();
  const count = state.status === "ready" ? countEntries(state.data) : null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="gap-1.5 px-2 text-muted-foreground"
      aria-label={count === null ? "Skills" : `Skills: ${count}`}
      onClick={() => toggleSkillsPopup(composer)}
    >
      <Icon name={SKILLS_ICON} aria-hidden />
      Skills
      {count === null ? null : <span className="tabular-nums">{count}</span>}
    </Button>
  );
}
