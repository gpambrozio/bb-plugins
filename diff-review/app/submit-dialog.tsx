/**
 * "Submit review…" in a pull request's view: your open comments as one GitHub review, with the verdict
 * shown and chosen here (Comment, Approve, Request changes) and a body. Line comments become review
 * threads; whole-file and whole-diff ones go into the body; one that cannot be posted says why. Agents'
 * drafts on GitHub's threads are listed apart, each left out until ticked, and go in as replies (a
 * resolving one resolves its thread once the review is in). It posts as the GitHub CLI's account on
 * the bb server's machine, only from this button.
 */
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

import type { RpcContract } from "../shared/contract";
import type { ReviewEvent } from "../shared/github";
import { BODY_MAX_CHARS } from "../shared/types";
import { errorMessage } from "./use-review";


const VERDICTS: { event: ReviewEvent; label: string }[] = [
  { event: "COMMENT", label: "Comment" },
  { event: "APPROVE", label: "Approve" },
  { event: "REQUEST_CHANGES", label: "Request changes" },
];

export function SubmitReviewDialog({
  open,
  onOpenChange,
  sessionId,
  headSha,
  pullNumber,
  onSubmitted,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  sessionId: string;
  headSha: string;
  pullNumber: number;
  onSubmitted(): void;
}) {
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  const [plan, setPlan] = useState<{
    lines: { reviewThreadId: string; location: string; body: string }[];
    body: { reviewThreadId: string; location: string; body: string }[];
    blocked: { reviewThreadId: string; location: string; reason: string }[];
    replies: { reviewThreadId: string; commentId: string; location: string; author: string; body: string; resolve: boolean }[];
  } | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  // Agents' drafts go in only when ticked here: each is the user's to approve.
  const [chosenReplies, setChosenReplies] = useState<Set<string>>(new Set());
  const [event, setEvent] = useState<ReviewEvent>("COMMENT");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  // The commit this dialog's review is of: fixed when it opens, with the comments it reads then.
  const [approvedHead, setApprovedHead] = useState<string | null>(null);

  // A view that loads new commits while the dialog is open closes it: what was approved was another commit.
  useEffect(() => {
    if (!open || approvedHead === null || headSha === approvedHead) return;
    onOpenChange(false);
    toast.info(`Pull request #${pullNumber} has new commits; open Submit review again to review them.`);
  }, [open, approvedHead, headSha, onOpenChange, pullNumber]);

  useEffect(() => {
    if (!open) {
      setApprovedHead(null);
      return;
    }
    setApprovedHead(headSha);
    // Each opening is a new review: the verdict is chosen again.
    setEvent("COMMENT");
    setPlan(null);
    setChosenReplies(new Set());
    rpc.call("reviewPlan", { sessionId }).then(
      (next) => {
        setPlan(next);
        setChosen(new Set([...next.lines, ...next.body].map((entry) => entry.reviewThreadId)));
      },
      (error: unknown) => toast.error(`Could not read your comments: ${errorMessage(error)}`),
    );
    // Not on `headSha`: the head is taken when the dialog opens, and a later one closes it (above).
  }, [open, rpc, sessionId]);

  // What each comment says as this dialog read it: that text, and only that, is what Submit posts.
  // Every row is drawn from the plan alone, never from the tab's threads, which may not have caught
  // up with it: each comment Submit would post is on screen.
  const approvedBody = (id: string) => [...(plan?.lines ?? []), ...(plan?.body ?? [])].find((entry) => entry.reviewThreadId === id)?.body;
  const row = ({ reviewThreadId: id, location, body: shown, reason }: { reviewThreadId: string; location: string; body: string; reason?: string }) => (
    <li key={id}>
      <label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-state-hover">
        <Checkbox
          checked={reason === undefined && chosen.has(id)}
          disabled={reason !== undefined}
          onCheckedChange={(checked) =>
            setChosen((previous) => {
              const next = new Set(previous);
              if (checked === true) next.add(id);
              else next.delete(id);
              return next;
            })
          }
          aria-label={`Include ${location}`}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-muted-foreground">{location}</span>
          {shown === "" ? null : <span className="block truncate text-sm">{shown}</span>}
          {reason === undefined ? null : <span className="block text-xs text-warning-text">{reason}</span>}
        </span>
      </label>
    </li>
  );

  const submit = async () => {
    setBusy(true);
    try {
      const items = [...chosen].flatMap((id) => {
        const text = approvedBody(id);
        return text === undefined ? [] : [{ reviewThreadId: id, body: text }];
      });
      const replies = (plan?.replies ?? []).filter((entry) => chosenReplies.has(entry.commentId)).map((entry) => ({ commentId: entry.commentId, body: entry.body }));
      if (approvedHead === null) return;
      const result = await rpc.call("submitReview", { sessionId, event, body, headSha: approvedHead, items, replies });
      toast.success(`Review submitted to pull request #${pullNumber}${result.posted === 0 ? "" : ` with ${result.posted} comment${result.posted === 1 ? "" : "s"}`}.`, {
        ...(result.url === null ? {} : { action: { label: "Open on GitHub", onClick: () => navigate.openUrl(result.url!) } }),
      });
      for (const warning of result.warnings) toast.warning(warning);
      setBody("");
      onSubmitted();
      onOpenChange(false);
    } catch (error) {
      toast.error(`Could not submit the review: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Submit a review of #{pullNumber}</DialogTitle>
          <DialogDescription>Posted to GitHub as the GitHub CLI's account on the bb server's machine.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1.5" role="radiogroup" aria-label="Verdict">
          {VERDICTS.map((verdict) => (
            <Button key={verdict.event} type="button" size="sm" role="radio" aria-checked={event === verdict.event} variant={event === verdict.event ? "default" : "outline"} onClick={() => setEvent(verdict.event)}>
              {verdict.label}
            </Button>
          ))}
        </div>
        <Textarea value={body} onChange={(change) => setBody(change.target.value)} placeholder="The review's summary (optional)" maxLength={BODY_MAX_CHARS} rows={3} />
        {plan === null || plan.replies.length === 0 ? null : (
          <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto" aria-label="Agents' drafts">
            {plan.replies.map((entry) => (
              <li key={entry.commentId}>
                <label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-state-hover">
                  <Checkbox
                    checked={chosenReplies.has(entry.commentId)}
                    onCheckedChange={(checked) =>
                      setChosenReplies((previous) => {
                        const next = new Set(previous);
                        if (checked === true) next.add(entry.commentId);
                        else next.delete(entry.commentId);
                        return next;
                      })
                    }
                    aria-label={`Include ${entry.author}'s draft on ${entry.location}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-muted-foreground">
                      {entry.author}'s draft · {entry.location}
                      {entry.resolve ? " · resolves the thread" : ""}
                    </span>
                    <span className="line-clamp-4 block whitespace-pre-wrap text-sm">{entry.body}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {plan === null ? (
          <p className="text-xs text-muted-foreground">Reading your comments…</p>
        ) : plan.lines.length + plan.body.length + plan.blocked.length === 0 ? (
          <p className="text-xs text-muted-foreground">You have no open comments here; the review carries only its summary.</p>
        ) : (
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto" aria-label="Your comments">
            {[...plan.lines, ...plan.body].map((entry) => row(entry))}
            {plan.blocked.map((entry) => row({ ...entry, body: "" }))}
          </ul>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={busy || plan === null || (event === "REQUEST_CHANGES" && body.trim() === "" && chosen.size === 0 && chosenReplies.size === 0)}>
            {busy ? "Submitting…" : `Submit: ${VERDICTS.find((verdict) => verdict.event === event)!.label}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

