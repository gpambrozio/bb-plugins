/**
 * The box a comment is written in: a new thread (with an optional severity), a reply, or an edit.
 * ⌘/Ctrl+Enter submits and Escape cancels, as in diffity.
 */
import { useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

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
  withSeverity = false,
  autoFocus = true,
  onBodyChange,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  submitLabel: string;
  initialBody?: string;
  withSeverity?: boolean;
  autoFocus?: boolean;
  /** Told of every edit, for a parent that must keep the text across a remount. */
  onBodyChange?(body: string): void;
  onSubmit(value: ComposerSubmit): Promise<void>;
  onCancel?(): void;
}) {
  const [body, setBody] = useState(initialBody);
  const [severity, setSeverity] = useState<string>(NO_SEVERITY);
  const [busy, setBusy] = useState(false);
  const empty = body.trim() === "";

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
        value={body}
        onChange={(event) => {
          setBody(event.target.value);
          onBodyChange?.(event.target.value);
        }}
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
          <Select value={severity} onValueChange={setSeverity} disabled={busy}>
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
