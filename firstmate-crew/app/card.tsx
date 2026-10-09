/**
 * One card: a crewmate, a backlog item, or both. Steering and interrupting go to the crewmate directly;
 * relaunching goes through the first mate, because it owns the brief the new crewmate starts from.
 * Ending archives the thread, which removes its worktree after bb's grace period — so a worker whose
 * task is not Done is only ended after the captain has said so.
 *
 * A backlog item's `(actions: …)` are buttons that send their prompt to the first mate, as a suggestion
 * does; a held item — the captain's call — also gets an Answer box, whose words go to the first mate
 * under the task's id and title. Both share the one send in flight (`./send-gate`).
 */
import { UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import type { rpcContract } from "../server";
import type { BacklogAction, BacklogItem, ColumnId, FleetCard } from "../shared/types";
import { ConfirmDialog } from "./confirm-dialog";
import { STATE_WORDS, STATUS_WORDS, answerText, isRunning, relativeTime, shortUrl } from "./format";
import { reportError } from "./notify";
import { useMateSender } from "./use-mate-sender";

const TONES: Readonly<Record<ColumnId, string>> = {
  queued: "border-l-muted-foreground",
  working: "border-l-primary",
  blocked: "border-l-destructive",
  parked: "border-l-muted-foreground",
  done: "border-l-foreground",
  failed: "border-l-destructive",
  idle: "border-l-muted-foreground",
};

const END_WARNING =
  "This worker's task isn't Done. Archiving removes its worktree after bb's grace period; only committed work can be restored.";

type Draft = { kind: "steer" | "relaunch"; text: string };

export function Card({
  card,
  onChanged,
  mateThreadId = null,
  showOpen = true,
}: {
  card: FleetCard;
  /** Called after an action lands, so the board refreshes without waiting for its poll. */
  onChanged: () => void;
  /** The first mate's thread, brought into view once an action or answer has reached it. */
  mateThreadId?: string | null;
  /** False where the worker's own thread is already in view. */
  showOpen?: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const mate = useMateSender();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const crew = card.crew;
  const backlog = card.backlog;

  function run(success: string, action: () => Promise<unknown>): void {
    setBusy(true);
    action()
      .then(() => {
        toast.success(success);
        setDraft(null);
        onChanged();
      })
      .catch(reportError)
      .finally(() => setBusy(false));
  }

  function end(confirmed: boolean): void {
    if (crew === null) return;
    setBusy(true);
    rpc
      .call("crew.end", { threadId: crew.threadId, confirmed })
      .then((result) => {
        if (result.needsConfirmation) setConfirmEnd(true);
        else if (result.ended) {
          toast.success("The worker was ended.");
          onChanged();
        }
      })
      .catch(reportError)
      .finally(() => setBusy(false));
  }

  /** Sends the captain's words to the first mate; refused while another send is out. */
  function tellMate(text: string, onSent?: () => void): void {
    mate.ask(text, () => {
      toast.success("Sent to the first mate.");
      onSent?.();
      onChanged();
      if (mateThreadId !== null) navigate.toThread(mateThreadId);
    });
  }

  function submitDraft(): void {
    if (crew === null || draft === null) return;
    const text = draft.text.trim();
    if (text === "") return;
    if (draft.kind === "steer") run("Sent to the worker.", () => rpc.call("crew.steer", { threadId: crew.threadId, text }));
    else run("Asked the first mate to relaunch it.", () => rpc.call("crew.relaunch", { threadId: crew.threadId, note: text }));
  }

  const facts = [card.project, card.kind, card.taskId, backlog?.blockedBy ? `after ${backlog.blockedBy}` : null].filter(
    (fact): fact is string => fact !== null && fact !== "",
  );
  const summary = [
    crew === null ? null : STATUS_WORDS[crew.status],
    crew === null ? (backlog?.outcome ?? backlog?.since ?? null) : relativeTime(new Date(crew.updatedAt).toISOString()),
  ].filter((part): part is string => part !== null && part !== "");

  return (
    <div className={cn("flex flex-col gap-2 rounded-lg border border-l-4 border-border bg-card p-3 text-card-foreground", TONES[card.column])}>
      <div className="text-sm font-semibold">{card.title}</div>
      {facts.length === 0 ? null : <div className="text-xs text-muted-foreground">{facts.join(" · ")}</div>}
      {card.report === null ? (
        backlog === null ? null : <div className="text-xs text-muted-foreground">Backlog: {backlog.section}</div>
      ) : (
        <div className="text-xs leading-relaxed">
          <span className="font-semibold">{STATE_WORDS[card.report.state]}: </span>
          {card.report.text}
        </div>
      )}
      {backlog?.hold ? (
        <div className="text-xs">
          <span className="font-semibold">Captain's call: </span>
          {backlog.hold}
        </div>
      ) : null}
      {backlog === null || backlog.actions.length === 0 ? null : (
        <BacklogActions actions={backlog.actions} sending={mate.sending} onPick={(action) => tellMate(action.prompt)} />
      )}
      {backlog?.hold ? <AnswerBox item={backlog} sending={mate.sending} onSend={tellMate} /> : null}
      {crew === null && backlog?.section === "in-flight" ? (
        <div className="text-xs text-muted-foreground">No worker is running for this item.</div>
      ) : null}
      {crew !== null && crew.pendingInteractions > 0 ? (
        <div className="text-xs text-destructive">
          Waiting on {crew.pendingInteractions === 1 ? "an answer" : `${crew.pendingInteractions} answers`}
        </div>
      ) : null}
      {card.url === null ? null : (
        <UrlLink href={card.url} className="truncate text-xs text-primary underline">
          {shortUrl(card.url)}
        </UrlLink>
      )}
      {summary.length === 0 ? null : <div className="text-xs text-muted-foreground">{summary.join(" · ")}</div>}

      {crew === null ? null : (
        <div className="flex flex-wrap gap-2">
          {showOpen ? (
            <Button size="sm" variant="outline" onClick={() => navigate.toThread(crew.threadId)}>
              Open thread
            </Button>
          ) : null}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setDraft({ kind: "steer", text: "" })}>
            Steer
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !isRunning(crew.status)} onClick={() => run("Interrupted.", () => rpc.call("crew.interrupt", { threadId: crew.threadId }))}>
            Interrupt
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setDraft({ kind: "relaunch", text: "" })}>
            Relaunch
          </Button>
          <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => end(false)}>
            End
          </Button>
        </div>
      )}

      {draft === null ? null : (
        <div className="flex flex-col gap-2">
          <Textarea
            value={draft.text}
            onChange={(event) => setDraft({ kind: draft.kind, text: event.target.value })}
            placeholder={
              draft.kind === "steer"
                ? "Tell the worker… (the first mate hears about it)"
                : "What the new worker should know: progress so far, what to avoid"
            }
            autoFocus
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || draft.text.trim() === ""} onClick={submitDraft}>
              {draft.kind === "steer" ? "Send" : "Relaunch"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmEnd}
        onOpenChange={setConfirmEnd}
        title="End this worker?"
        description={END_WARNING}
        confirmLabel="End it"
        onConfirm={() => end(true)}
      />
    </div>
  );
}

function BacklogActions({
  actions,
  sending,
  onPick,
}: {
  actions: readonly BacklogAction[];
  sending: boolean;
  onPick: (action: BacklogAction) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action, index) => (
        <Button
          key={`${index}:${action.label}`}
          size="sm"
          variant="secondary"
          className="max-w-full"
          disabled={sending}
          aria-label={`${action.label}: send "${action.prompt}" to the first mate`}
          onClick={() => onPick(action)}
        >
          <span className="truncate">{action.label}</span>
        </Button>
      ))}
    </div>
  );
}

/**
 * A line for the captain's own answer to a hold, sent under the task's id and title. The line is shut while
 * a send is out: a landed send clears it and may bring the first mate's thread into view, which unmounts a
 * worker's panel, so words typed meanwhile would be lost either way.
 */
function AnswerBox({
  item,
  sending,
  onSend,
}: {
  item: BacklogItem;
  sending: boolean;
  onSend: (text: string, onSent: () => void) => void;
}) {
  const [text, setText] = useState("");
  const answer = text.trim();

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (answer === "" || sending) return;
        onSend(answerText(item, answer), () => setText(""));
      }}
    >
      <Input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Answer the first mate…"
        aria-label={`Answer for ${item.id}`}
        disabled={sending}
        className="h-8 min-w-0 flex-1 text-xs"
      />
      <Button type="submit" size="sm" className="shrink-0" disabled={sending || answer === ""}>
        Send
      </Button>
    </form>
  );
}
