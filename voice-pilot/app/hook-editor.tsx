/**
 * Voice Pilot's own editor for a machine's hook script, drawn by bb in its file panel (a `fileOpener` that no
 * extension selects: the settings' Open the script names it). bb's File Editor cannot load a file on a machine
 * from a plugin page (bb 0.50.1 resolves such a file only through an environment), so this one loads and saves
 * the file through Voice Pilot's host entry on that machine: by its name, never a path, keeping its
 * permissions, and only when the file has not changed on disk since it was loaded. A change on disk is a
 * warning with Reload and Save anyway; a machine that does not answer, or a save that fails there, says so.
 */
import { experimental_Icon as Icon, useRpc, type PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { rpcContract } from "../server";
import { hookShown, type HookName } from "../shared/hooks";
import { editorMachine } from "./hook-file";

type Loaded = { name: HookName; path: string; sha256: string; executable: boolean; content: string };
type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "missing" } | { kind: "unsupported"; reason: string } | { kind: "text"; file: Loaded };
type Notice = { tone: "ok" | "warning" | "error"; text: string } | null;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a save that went through says. */
export function savedText(machine: string, executable: boolean): string {
  return executable ? `Saved on ${machine}. It is still executable.` : `Saved on ${machine}. It is not executable, so it does not run (chmod +x).`;
}

export const CONFLICT_TEXT =
  "The file changed on disk since it was loaded. Reload to see what is there now (your edits here are lost), or Save anyway to replace it with your version.";
export const GONE_TEXT = "The file is no longer there: it was removed or renamed since it was loaded. Reload to see which hook file there is now.";

export function HookEditor({ path, source }: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const known = editorMachine(path);
  const hostId = source.experimental_hostId ?? known?.hostId ?? null;
  const machine = known?.machine ?? "its machine";
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  /** Set when a save found the file changed on disk: the hash it has now, or null when it is gone. */
  const [conflict, setConflict] = useState<{ currentSha256: string | null } | null>(null);

  const load = useCallback(async () => {
    if (hostId === null) {
      setState({ kind: "error", message: "bb did not say which machine this file is on. Open it again from Voice Pilot's settings." });
      return;
    }
    setState({ kind: "loading" });
    setConflict(null);
    try {
      const read = await rpc.call("hooks.read", { hostId });
      if (read.kind === "text") {
        setState({ kind: "text", file: read });
        setDraft(read.content);
      } else if (read.kind === "missing") setState({ kind: "missing" });
      else setState({ kind: "unsupported", reason: read.reason });
    } catch (error) {
      setState({ kind: "error", message: errorText(error) });
    }
  }, [rpc, hostId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (file: Loaded, expectedSha256: string) => {
    if (hostId === null) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await rpc.call("hooks.write", { hostId, name: file.name, content: draft, expectedSha256 });
      if (result.outcome === "written") {
        setState({ kind: "text", file: { ...file, sha256: result.sha256, executable: result.executable, content: draft } });
        setConflict(null);
        setNotice({ tone: result.executable ? "ok" : "warning", text: savedText(machine, result.executable) });
      } else if (result.outcome === "conflict") {
        setConflict({ currentSha256: result.currentSha256 });
      } else {
        setNotice({ tone: "error", text: `Could not save it on ${machine}: ${result.reason}` });
      }
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const reload = () => {
    setNotice(null);
    void load();
  };

  if (state.kind !== "text") {
    const text =
      state.kind === "loading"
        ? `Loading the hook script from ${machine}…`
        : state.kind === "missing"
          ? `${machine} has no hook script any more.`
          : state.kind === "unsupported"
            ? `This hook script cannot be edited here. ${state.reason}`
            : state.message;
    return (
      <div className="flex h-full flex-col gap-2 bg-background p-4 text-sm text-foreground">
        <p className={`m-0 ${state.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}>{text}</p>
        {state.kind !== "loading" && (
          <div>
            <Button type="button" size="sm" variant="outline" onClick={reload}>
              Reload
            </Button>
          </div>
        )}
      </div>
    );
  }

  const file = state.file;
  const changed = draft !== file.content;
  return (
    <div aria-label="Voice hook editor" className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
        <Icon name="Code" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {hookShown(file.path)} on {machine}
          {changed ? " · unsaved" : ""}
        </span>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={reload}>
          Reload
        </Button>
        <Button type="button" size="sm" disabled={busy || !changed || conflict !== null} onClick={() => void save(file, file.sha256)}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
      {conflict !== null && (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-warning px-3 py-2 text-xs text-warning-text">
          <span className="min-w-0 flex-1">{conflict.currentSha256 === null ? GONE_TEXT : CONFLICT_TEXT}</span>
          {conflict.currentSha256 !== null && (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void save(file, conflict.currentSha256 ?? "")}>
              Save anyway
            </Button>
          )}
        </div>
      )}
      {notice !== null && (
        <p role="status" className={`m-0 border-b border-border px-3 py-2 text-xs ${notice.tone === "error" ? "text-destructive" : notice.tone === "warning" ? "text-warning-text" : "text-muted-foreground"}`}>
          {notice.text}
        </p>
      )}
      {!file.executable && notice === null && (
        <p className="m-0 border-b border-border px-3 py-2 text-xs text-warning-text">This file is not executable, so it does not run (chmod +x). Saving keeps its permissions as they are.</p>
      )}
      <textarea
        aria-label="Hook script"
        spellCheck={false}
        className="min-h-0 flex-1 resize-none bg-background p-3 font-mono text-xs leading-5 text-foreground outline-none"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          if (notice?.tone !== "error") setNotice(null);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "s") {
            event.preventDefault();
            if (changed && !busy && conflict === null) void save(file, file.sha256);
          }
        }}
      />
    </div>
  );
}
