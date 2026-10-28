/**
 * One comment thread: its comments (Markdown), where it stands with the agent, and the user's
 * actions — reply, resolve or reopen, dismiss, edit or delete their own comments. Resolved and
 * dismissed threads fold to one line.
 */
import { Markdown } from "@get-bb/plugin-sdk/app";
import { Fragment } from "react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

import type { Placement } from "../shared/anchors";
import { bodyParts } from "../shared/suggestion";
import { describeLocation, type ReviewComment, type ReviewThread } from "../shared/types";
import { useActions } from "./actions";
import { CommentComposer } from "./comment-composer";
import { ago, DELIVERY_LABELS, SEVERITY_LABELS, STATUS_LABELS } from "./labels";
import { SuggestionBlock, SuggestionThreadContext, type SuggestionThread } from "./suggestion-block";
import { draftKeys, useDraft, useViewState } from "./view-state";

function Delivery({ thread }: { thread: ReviewThread }) {
  const actions = useActions();
  if (thread.delivery === null) return null;
  const { state, threadId } = thread.delivery;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", state === "no_reply" ? "text-warning-text" : "text-muted-foreground")}>
      <Icon name={state === "answered" ? "Check" : state === "sent" ? "Sent" : "AlertTriangle"} className="size-3.5" />
      {DELIVERY_LABELS[state]}
      {state === "no_reply" ? (
        <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => actions.openThread(threadId)}>
          Open the thread
        </Button>
      ) : null}
    </span>
  );
}

function Comment({ comment }: { comment: ReviewComment }) {
  const actions = useActions();
  const editDraft = useDraft(draftKeys.edit(comment.id));
  const editing = editDraft.active !== null;
  const own = comment.authorType === "user";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon name={own ? "UserRound" : "Bot"} className="size-3.5" />
        <span className="font-medium text-foreground">{comment.authorName}</span>
        <span>{ago(comment.createdAt)}</span>
        {comment.editedAt === null ? null : <span>(edited)</span>}
        {own && !editing ? (
          <span className="ml-auto flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => editDraft.open({ body: comment.body })}>
              Edit
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => void actions.remove(comment.id).catch(() => undefined)}>
              Delete
            </Button>
          </span>
        ) : null}
      </div>
      {editing ? (
        <CommentComposer
          placeholder="Edit your comment"
          submitLabel="Save"
          initialBody={editDraft.latest().body}
          onChange={editDraft.change}
          onSubmit={async ({ body }) => {
            await actions.edit(comment.id, body);
            editDraft.close();
          }}
          onCancel={editDraft.close}
        />
      ) : (
        <CommentBody comment={comment} />
      )}
    </div>
  );
}

/** A comment's Markdown, with each ```suggestion block drawn as a suggested change. */
function CommentBody({ comment }: { comment: ReviewComment }) {
  const parts = bodyParts(comment.body);
  if (parts.length === 1 && parts[0]!.kind === "text") return <Markdown content={comment.body} className="text-sm" />;
  return (
    <div className="flex flex-col gap-2">
      {parts.map((part, index) => (
        <Fragment key={index}>{part.kind === "text" ? <Markdown content={part.text} className="text-sm" /> : <SuggestionBlock code={part.code} commentId={comment.id} />}</Fragment>
      ))}
    </div>
  );
}

/**
 * `fileChanged`: the file changed since the thread was made on it, though its lines may still be found.
 * `current`: where the thread's lines are in the diff now and what they read, for its suggestions.
 */
export function ThreadCard({
  thread,
  placement,
  fileChanged = false,
  current,
}: {
  thread: ReviewThread;
  placement?: Placement;
  fileChanged?: boolean;
  current?: SuggestionThread["current"];
}) {
  const actions = useActions();
  const viewState = useViewState();
  const closed = thread.status !== "open";
  const replyDraft = useDraft(draftKeys.reply(thread.id));
  const replying = replyDraft.active !== null;
  // A thread stays as the user left it (kept with the view); otherwise closed ones start folded. A
  // folded thread with a reply being written opens, so the reply shows.
  const [expanded, setExpandedState] = useState(() => replying || (viewState.threadExpanded(thread.id) ?? !closed));
  const setExpanded = (value: boolean) => {
    viewState.setThreadExpanded(thread.id, value);
    setExpandedState(value);
  };
  // Dismissing folds the thread at once; a click on the folded line opens it again.
  const dismiss = () =>
    void actions
      .setStatus(thread.id, "dismissed")
      .then(() => setExpanded(false))
      .catch(() => undefined);
  const first = thread.comments[0];

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      {thread.severity === null ? null : (
        <Badge variant={thread.severity === "must-fix" ? "destructive" : "secondary"} className="text-[11px]">
          {SEVERITY_LABELS[thread.severity]}
        </Badge>
      )}
      {closed ? <Badge variant="outline" className="text-[11px]">{STATUS_LABELS[thread.status]}</Badge> : null}
      {placement?.state === "moved" ? (
        <span className="text-xs text-muted-foreground">
          Moved from line {thread.startLine}
        </span>
      ) : null}
      {placement?.state === "outdated" ? <span className="text-xs text-muted-foreground">{describeLocation(thread)}</span> : null}
      {fileChanged && placement?.state !== "outdated" ? <span className="text-xs text-muted-foreground">File changed since this comment</span> : null}
      <Delivery thread={thread} />
    </div>
  );

  if (!expanded) {
    return (
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-left text-xs text-muted-foreground hover:bg-state-hover"
        onClick={() => setExpanded(true)}
      >
        <Icon name="ChevronRight" className="size-3.5" />
        {header}
        <span className="min-w-0 flex-1 truncate">{first?.body ?? ""}</span>
        <span>{thread.comments.length} comment{thread.comments.length === 1 ? "" : "s"}</span>
      </button>
    );
  }

  return (
    <SuggestionThreadContext.Provider value={{ thread, ...(current === undefined ? {} : { current }) }}>
    <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-3 font-sans text-foreground" data-thread-id={thread.id}>
      <div className="flex items-start gap-2">
        {header}
        {closed ? (
          <Button type="button" variant="ghost" size="sm" className="ml-auto h-6 px-1.5" aria-label="Fold" onClick={() => setExpanded(false)}>
            <Icon name="ChevronUp" className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {placement?.state === "outdated" && thread.anchorContent !== null ? (
        <pre className="max-h-32 overflow-auto rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">{thread.anchorContent}</pre>
      ) : null}
      {thread.comments.map((comment) => (
        <Comment key={comment.id} comment={comment} />
      ))}
      {replying ? (
        <CommentComposer
          placeholder="Reply (@reviewer or @agent asks this view's AI reviewer)"
          submitLabel="Reply"
          initialBody={replyDraft.latest().body}
          onChange={replyDraft.change}
          onSubmit={async ({ body }) => {
            await actions.reply(thread.id, body);
            replyDraft.close();
          }}
          onCancel={replyDraft.close}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => replyDraft.open()}>
            Reply
          </Button>
          {closed ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => void actions.setStatus(thread.id, "open").catch(() => undefined)}>
              Reopen
            </Button>
          ) : (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={() => void actions.setStatus(thread.id, "resolved").catch(() => undefined)}>
                Resolve
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={dismiss}>
                Dismiss
              </Button>
            </>
          )}
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">{thread.id}</span>
        </div>
      )}
    </div>
    </SuggestionThreadContext.Provider>
  );
}
