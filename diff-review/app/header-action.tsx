/**
 * The Review button in a thread's title bar: an icon of its own, beside bb's own buttons. bb 0.48
 * draws every plugin's `placement: "header"` thread action as one shared split button (the first
 * plugin's label, the others in its dropdown), so Review uses the older header slot,
 * `experimental_threadHeaderAction`, which bb 0.48 still draws as each plugin's own control but no
 * longer types. It opens the Review tab, or closes it when it shows, through bb's panel controller.
 */
import { experimental_useAppPanel, type PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import { openReviewTab, REVIEW_TAB } from "./tab";

const LABEL = "Review this thread's changes";

/** What bb hands the old header slot's component. */
export interface HeaderActionProps {
  threadId: string;
  projectId: string;
  isCompactViewport: boolean;
}

export function ReviewHeaderButton(_props: HeaderActionProps) {
  // bb 0.48 mounts the header inside the thread's panel controller, as it does the thread's tabs.
  const panel = experimental_useAppPanel();
  const toggle = () => {
    panel.toggleTab({ tab: REVIEW_TAB });
  };
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={LABEL} onClick={toggle}>
            <Icon name="FileDiff" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{LABEL}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type LegacySlots = { experimental_threadHeaderAction?: (registration: { id: string; title: string; component: ComponentType<HeaderActionProps> }) => void };

/**
 * Registers exactly one Review control in the thread's header: the old icon slot where bb has it
 * (bb 0.48 does), else, on a bb that dropped it, a `placement: "header"` thread action.
 */
export function registerReviewHeader(app: PluginAppBuilder): "icon" | "thread-action" {
  const legacy = (app.slots as unknown as LegacySlots).experimental_threadHeaderAction;
  if (typeof legacy === "function") {
    legacy.call(app.slots, { id: "review", title: "Review", component: ReviewHeaderButton });
    return "icon";
  }
  app.slots.experimental_threadAction({
    id: "review",
    title: "Review",
    icon: "FileDiff",
    group: "diff-review",
    placement: "header",
    item: ({ experimental_panel }) => ({
      label: "Review",
      detail: LABEL,
      icon: "FileDiff",
      run: () => {
        openReviewTab(experimental_panel);
      },
    }),
  });
  return "thread-action";
}
