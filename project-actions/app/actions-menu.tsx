// The Actions button in a thread's header and its menu: the project's actions as the thread's
// branch has them, read again each time the menu opens.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import { FORMAT_URL, type ActionView } from "../shared/views";
import { actionsModel, OFFER_LABELS, STATUS_LABELS, type ActionsModel, type Offer } from "./model";
import { useProjectActions, type ActionsState } from "./use-actions";

export const BUTTON_LABEL = "Project actions";

const OFFER_ICONS: Record<Offer, string> = { retry: "RotateCcw", format: "ExternalLink" };

/** What bb hands the header slot's component. */
export interface HeaderActionProps {
  threadId: string;
  projectId: string;
  isCompactViewport: boolean;
}

/** A note's text: the same in the menu and in the panel. */
export function NoteText({ model }: { model: Extract<ActionsModel, { kind: "note" }> }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-foreground">{model.title}</span>
      {model.body === "" ? null : <span className="text-muted-foreground">{model.body}</span>}
      {model.code === null ? null : <span className="font-mono text-xs text-foreground">{model.code}</span>}
      {model.error === null ? null : <span className="text-destructive">{model.error}</span>}
      {model.location === null ? null : <span className="font-mono text-xs text-muted-foreground">{model.location}</span>}
    </div>
  );
}

/** An action's name, and its description or else its command. */
export function ActionText({ action }: { action: ActionView }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="truncate">{action.name}</span>
      {action.description === null ? (
        <span className="truncate font-mono text-xs text-muted-foreground">{action.command}</span>
      ) : (
        <span className="truncate text-xs text-muted-foreground">{action.description}</span>
      )}
    </div>
  );
}

export function ActionsMenuBody({ state, onRun, onOffer }: { state: ActionsState; onRun: (name: string) => void; onOffer: (offer: Offer) => void }) {
  const model = actionsModel(state);
  if (model.kind === "loading") {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
        <Icon name="Spinner" className="animate-spin" />
        {model.text}
      </div>
    );
  }
  if (model.kind === "note") {
    return (
      <>
        <div className="px-2 py-1.5">
          <NoteText model={model} />
        </div>
        <DropdownMenuSeparator />
        {model.offers.map((offer) => (
          <DropdownMenuItem
            key={offer}
            onSelect={(event) => {
              // Trying again keeps the menu open on the new answer.
              if (offer === "retry") event.preventDefault();
              onOffer(offer);
            }}
          >
            <Icon name={OFFER_ICONS[offer]} />
            {OFFER_LABELS[offer]}
          </DropdownMenuItem>
        ))}
      </>
    );
  }
  return (
    <>
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Run in a terminal</DropdownMenuLabel>
      {model.actions.map((action) => {
        const status = STATUS_LABELS[action.status];
        return (
          <DropdownMenuItem key={action.name} onSelect={() => onRun(action.name)} className="items-start gap-2" title={action.command}>
            <Icon name={action.status === "running" ? "Terminal" : "Play"} className="mt-0.5 shrink-0 text-muted-foreground" />
            <ActionText action={action} />
            {status === null ? null : <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">{status}</span>}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

export function ActionsHeaderButton({ threadId }: HeaderActionProps) {
  const navigate = useBbNavigate();
  const { state, load, run } = useProjectActions(threadId);
  const offer = (choice: Offer) => {
    if (choice === "retry") load();
    else navigate.openUrl(FORMAT_URL);
  };
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) load();
      }}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={BUTTON_LABEL}>
                <Icon name="Play" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{BUTTON_LABEL}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent align="end" className="w-80">
        <ActionsMenuBody state={state} onRun={(name) => void run(name)} onOffer={offer} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
