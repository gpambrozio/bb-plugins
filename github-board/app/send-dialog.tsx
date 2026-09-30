/**
 * Send to chat: bb's own new-thread composer, in a dialog, opened on one card.
 *
 * The composer owns the prompt editor and every picker — provider, model,
 * reasoning, project, environment, permission mode — so a provider without a
 * selectable model is bb's to leave out, not ours. It only resolves a request;
 * the server starts the thread with the card's title and the card itself as
 * plugin metadata, and remembers the selections for the next card.
 *
 * The draft is kept per card (`draftKey`), so closing the dialog mid-edit loses
 * nothing: reopening the same card brings the edit back, and `initialPrompt`
 * seeds only an empty draft. That is why the dialog closes on every ordinary
 * dismissal, where Paseo's had to refuse while the prompt was edited.
 */
import { useEffect, useState, type ComponentProps } from "react";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import type { BoardItem, ColumnId } from "../shared/board";
import type { LaunchDefaults, NewThreadRequestInput } from "../shared/schemas";
import { renderTemplate, templateFor } from "../shared/settings";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorText, useBoardRpc, usePrompts } from "./state";

type ComposerProps = ComponentProps<typeof NewThreadComposer>;

interface SendOptions {
  project: { id: string; name: string } | null;
  candidates: { id: string; name: string }[];
  launch: LaunchDefaults | null;
}

/** The saved selections as the composer's seeds. The composer reconciles any that no longer exist. */
function seedsFrom(launch: LaunchDefaults | null): Partial<ComposerProps> {
  if (launch === null) return {};
  return {
    defaultProviderId: launch.providerId,
    defaultModel: launch.model,
    defaultReasoningLevel: launch.reasoningLevel as ComposerProps["defaultReasoningLevel"],
    defaultPermissionMode: launch.permissionMode as ComposerProps["defaultPermissionMode"],
    ...(launch.serviceTier === undefined
      ? {}
      : { defaultServiceTier: launch.serviceTier as ComposerProps["defaultServiceTier"] }),
    ...(launch.environment === undefined
      ? {}
      : { defaultEnvironment: launch.environment as ComposerProps["defaultEnvironment"] }),
  };
}

function SendBody({
  item,
  column,
  onSent,
}: {
  item: BoardItem;
  column: ColumnId;
  onSent(): void;
}) {
  const rpc = useBoardRpc();
  const navigate = useBbNavigate();
  const { prompts, error: promptsError } = usePrompts();
  const [options, setOptions] = useState<SendOptions | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    rpc.call("sendOptions", { repository: item.repository, url: item.url }).then(
      (value) => {
        if (live) setOptions(value);
      },
      (cause: unknown) => {
        if (live) setError(errorText(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, item.repository, item.url]);

  const problem = error ?? promptsError;
  if (problem !== null) return <p className="text-sm text-destructive">{problem}</p>;
  // The composer re-seeds every selection whenever a seed changes, so it is
  // mounted only once every seed is known.
  if (options === null || prompts === null) {
    return <div className="h-40 animate-pulse rounded-md bg-muted" aria-label="Loading" />;
  }

  const prompt = renderTemplate(templateFor(prompts, column, options.project?.id ?? null), item);
  const others = options.candidates.filter((candidate) => candidate.id !== options.project?.id);

  return (
    <div className="space-y-3">
      {options.project === null ? (
        <p className="text-sm text-muted-foreground">
          No bb project has a git remote pointing at {item.repository}. Pick the project to work in below, or add
          one whose checkout has that remote.
        </p>
      ) : others.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Also checked out as {others.map((other) => other.name).join(", ")}; switch project below to use one.
        </p>
      ) : null}
      <NewThreadComposer
        draftKey={`github-board:send:${item.id}`}
        initialPrompt={prompt}
        {...(options.project === null ? {} : { defaultProjectId: options.project.id })}
        {...seedsFrom(options.launch)}
        onSubmit={async (request) => {
          // Throwing keeps the draft, so a failed start never loses the prompt.
          const card = {
            id: item.id,
            repository: item.repository,
            number: item.number,
            title: item.title,
            url: item.url,
            author: item.author,
            labels: item.labels,
          };
          try {
            // bb documents the request as JSON-serialisable; its declared type
            // just does not say so, and the server validates what it reads.
            const json = request as unknown as NewThreadRequestInput;
            const { threadId } = await rpc.call("send", { card, request: json });
            onSent();
            navigate.toThread(threadId);
          } catch (cause) {
            toast.error(`Could not start the thread: ${errorText(cause)}`);
            throw cause;
          }
        }}
      />
    </div>
  );
}

export function SendDialog({
  target,
  onOpenChange,
}: {
  target: { item: BoardItem; column: ColumnId } | null;
  onOpenChange(open: boolean): void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        {target === null ? null : (
          <>
            <DialogHeader>
              <DialogTitle className="truncate pr-6">Send to chat</DialogTitle>
              <DialogDescription className="truncate">
                {target.item.repository}#{target.item.number} · {target.item.title}
              </DialogDescription>
            </DialogHeader>
            <SendBody
              key={target.item.id}
              item={target.item}
              column={target.column}
              onSent={() => onOpenChange(false)}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
