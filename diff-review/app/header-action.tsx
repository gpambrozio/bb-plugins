/**
 * The Review button in a thread's title bar: opens (or focuses) the thread's Review tab. One 28px
 * control, as the host asks of a header action, with bb's tooltip in place of a `title`.
 */
import { useBbNavigate, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import { PANEL_ACTION_ID } from "./review-panel";

const LABEL = "Review this thread's changes";

export function ReviewHeaderAction(_props: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={LABEL}
            onClick={() => void navigate.openThreadPanel({ actionId: PANEL_ACTION_ID })}
          >
            <Icon name="FileDiff" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{LABEL}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
