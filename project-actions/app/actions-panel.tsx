// The fallback for a bb that no longer draws the header slot the Actions button uses: a header
// thread action opens this tab beside the thread, with the same actions as buttons.
import { experimental_useAppPanel, useBbNavigate, type ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

import { FORMAT_URL } from "../shared/views";
import { ActionText, NoteText } from "./actions-menu";
import { actionsModel, EDIT_LABEL, STATUS_LABELS, type Offer } from "./model";
import { EDITOR_TAB } from "./tabs";
import { useProjectActions } from "./use-actions";

export function ActionsPanel({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const { state, load, run } = useProjectActions(threadId);
  const offer = (choice: Offer) => {
    if (choice === "retry") load();
    else if (choice === "edit") panel.openTab({ tab: EDITOR_TAB });
    else navigate.openUrl(FORMAT_URL);
  };
  useEffect(() => load(), [load]);
  const model = actionsModel(state);
  return (
    <div className="flex flex-col gap-3 p-3">
      {model.kind === "loading" ? <p className="text-sm text-muted-foreground">{model.text}</p> : null}
      {model.kind === "note" ? (
        <>
          <NoteText model={model} />
          <div className="flex flex-wrap gap-2">
            {model.offers.map(({ offer: choice, label }) => (
              <Button key={choice} type="button" variant="outline" size="sm" onClick={() => offer(choice)}>
                {label}
              </Button>
            ))}
          </div>
        </>
      ) : null}
      {model.kind === "actions" ? (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Run in a terminal</span>
            <div className="flex gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => offer("edit")}>
                <Icon name="EditFile" />
                {EDIT_LABEL.replace("…", "")}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={load}>
                <Icon name="RotateCcw" />
                Refresh
              </Button>
            </div>
          </div>
          <ul className="flex flex-col gap-1">
            {model.actions.map((action) => {
              const status = STATUS_LABELS[action.status];
              return (
                <li key={action.name}>
                  <button
                    type="button"
                    title={action.command}
                    className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover"
                    onClick={() => {
                      void run(action.name).then(load);
                    }}
                  >
                    <Icon name={action.status === "running" ? "Terminal" : "Play"} className="mt-0.5 shrink-0 text-muted-foreground" />
                    <ActionText action={action} />
                    {status === null ? null : <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">{status}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export function ActionsTab({ threadId }: ExperimentalThreadTabProps) {
  return <ActionsPanel threadId={threadId} />;
}
