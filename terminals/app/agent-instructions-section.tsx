/**
 * The plugin's section in bb's settings: the instructions a tab's agent chat
 * is given, which the owner can read, edit or add to, and put back to the
 * built-in text. Kept in plugin storage, not in bb's settings form, which has
 * no way back to a field's default.
 *
 * The plugin always puts one fixed line first, naming the tab and machine the
 * chat's tools act on, so the agent knows its terminal whatever the text says;
 * `{{tab}}` and `{{machine}}` in the text are filled in the same way.
 */
import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";

import { DEFAULT_INSTRUCTIONS, FIXED_INSTRUCTIONS, INSTRUCTION_PLACEHOLDERS, MAX_INSTRUCTIONS_LENGTH } from "../shared/agent";
import type { RpcContract } from "../shared/contract";

const FIELD_CLASS =
  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AgentInstructionsSection() {
  const rpc = useRpc<RpcContract>();
  /** What is saved: null is the built-in text; undefined until read. */
  const [stored, setStored] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    rpc
      .call("agentInstructions", {})
      .then(({ text }) => {
        if (!live) return;
        setStored(text);
        setDraft(text ?? DEFAULT_INSTRUCTIONS);
      })
      .catch((error: unknown) => live && setStatus({ tone: "error", text: `Could not read the instructions: ${message(error)}` }));
    return () => {
      live = false;
    };
  }, [rpc]);

  const save = async (text: string | null) => {
    setSaving(true);
    setStatus(null);
    try {
      const saved = await rpc.call("setAgentInstructions", { text });
      setStored(saved.text);
      setDraft(saved.text ?? DEFAULT_INSTRUCTIONS);
      setStatus({ tone: "info", text: saved.text === null ? "Using the built-in instructions." : "Saved." });
    } catch (error) {
      setStatus({ tone: "error", text: `Could not save the instructions: ${message(error)}` });
    } finally {
      setSaving(false);
    }
  };

  if (stored === undefined) {
    return status === null ? <p className="text-xs text-muted-foreground">Reading the instructions…</p> : <p role="alert" className="text-xs text-destructive">{status.text}</p>;
  }
  const current = stored ?? DEFAULT_INSTRUCTIONS;
  const tooLong = draft.length > MAX_INSTRUCTIONS_LENGTH;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        What the agent chat of a terminal tab is told before your first message. Changes apply to chats started afterwards (and to an
        existing chat when its agent session next starts). The plugin always adds this line first, so the agent knows its terminal
        whatever you write here:
      </p>
      <pre className="whitespace-pre-wrap rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">{FIXED_INSTRUCTIONS}</pre>
      <p className="text-xs text-muted-foreground">
        {INSTRUCTION_PLACEHOLDERS.tab} and {INSTRUCTION_PLACEHOLDERS.machine}, here or in your text, become the tab&apos;s name and its
        machine&apos;s, in quotes. Saving an empty text goes back to the built-in one.
      </p>
      <textarea
        aria-label="Agent instructions"
        className={`${FIELD_CLASS} min-h-48`}
        rows={16}
        value={draft}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
      />
      {tooLong ? <p className="text-xs text-destructive">At most {MAX_INSTRUCTIONS_LENGTH.toLocaleString()} characters.</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={saving || tooLong || draft === current} onClick={() => void save(draft)}>
          Save instructions
        </Button>
        {stored === null ? null : (
          <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => void save(null)}>
            Restore the built-in instructions
          </Button>
        )}
        {status === null ? null : (
          <span role={status.tone === "error" ? "alert" : "status"} className={`text-xs ${status.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}>
            {status.text}
          </span>
        )}
      </div>
    </div>
  );
}
