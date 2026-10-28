/**
 * The box a comment is written in: a new thread (with an optional severity), a reply, or an edit.
 * ⌘/Ctrl+Enter submits and Escape cancels, as in diffity.
 */
import { useRef, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { insertSuggestion } from "../shared/suggestion";
import { BODY_MAX_CHARS, SEVERITIES, type Severity } from "../shared/types";
import { SEVERITY_LABELS } from "./labels";

const NO_SEVERITY = "none";

export interface ComposerSubmit {
  body: string;
  severity: Severity | null;
}

export function CommentComposer({
  placeholder,
  submitLabel,
  initialBody = "",
  initialSeverity = null,
  withSeverity = false,
  autoFocus = true,
  suggestFrom,
  onChange,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  submitLabel: string;
  initialBody?: string;
  initialSeverity?: Severity | null;
  withSeverity?: boolean;
  autoFocus?: boolean;
  /** The commented lines' text: offers "Suggest a change", which inserts a suggestion block seeded with it. */
  suggestFrom?: string;
  /** Told of every edit, for a parent that keeps the draft (across a remount, a reload, a restart). */
  onChange?(value: ComposerSubmit): void;
  onSubmit(value: ComposerSubmit): Promise<void>;
  onCancel?(): void;
}) {
  const [body, setBody] = useState(initialBody);
  const [severity, setSeverity] = useState<string>(initialSeverity ?? NO_SEVERITY);
  const [busy, setBusy] = useState(false);
  const empty = body.trim() === "";
  const textarea = useRef<HTMLTextAreaElement>(null);

  const change = (next: string, nextSeverity: string = severity) => {
    setBody(next);
    onChange?.({ body: next, severity: nextSeverity === NO_SEVERITY ? null : (nextSeverity as Severity) });
  };

  const suggest = () => {
    if (suggestFrom === undefined) return;
    const cursor = textarea.current?.selectionStart ?? body.length;
    const next = insertSuggestion(body, cursor, suggestFrom);
    change(next.body);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(next.cursor, next.cursor + suggestFrom.replace(/\n$/, "").length);
    });
  };

  const submit = async () => {
    if (empty || busy) return;
    setBusy(true);
    try {
      await onSubmit({ body, severity: severity === NO_SEVERITY ? null : (severity as Severity) });
      setBody("");
      setSeverity(NO_SEVERITY);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape" && onCancel !== undefined) {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        ref={textarea}
        value={body}
        onChange={(event) => change(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        maxLength={BODY_MAX_CHARS}
        rows={3}
        autoFocus={autoFocus}
        disabled={busy}
        className="min-h-16 text-sm"
      />
      <div className="flex items-center gap-2">
        {withSeverity ? (
          <Select
            value={severity}
            onValueChange={(value) => {
              setSeverity(value);
              onChange?.({ body, severity: value === NO_SEVERITY ? null : (value as Severity) });
            }}
            disabled={busy}
          >
            <SelectTrigger className="h-8 w-36 text-xs" aria-label="Severity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_SEVERITY}>No severity</SelectItem>
              {SEVERITIES.map((value) => (
                <SelectItem key={value} value={value}>
                  {SEVERITY_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {suggestFrom === undefined ? null : (
          <Button type="button" variant="ghost" size="sm" onClick={suggest} disabled={busy}>
            Suggest a change
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {onCancel === undefined ? null : (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          )}
          <Button type="button" size="sm" onClick={() => void submit()} disabled={empty || busy}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
