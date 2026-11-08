/**
 * The export dialog: writes the orientation as Markdown in the project (default `ORIENTATION.md` at its
 * root). Where is chosen in a folder browser over the project's checkout (the `browseOrientationFolder`
 * read, one folder at a time: open a folder, **Up** to its parent, pick an existing file to take its name)
 * and a file name box. Every path is built from the listed names and a name with no folders in it, so it
 * stays inside the workspace; the server checks again. This works wherever bb runs (desktop, a browser,
 * a remote machine, mobile): bb offers plugins no native save dialog.
 *
 * An existing file is never overwritten silently: the first call answers `{ exists: true, sha256 }`, the
 * dialog asks, and **Replace** sends `replace: true` with that hash as `expectedSha256`, so a file changed
 * while the user decided is refused (its message shows here and the dialog stays open to export again).
 * Every button is `type="button"`: the dialog may sit inside a form.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { errorText, useLearningRpc, useOrientationFolder } from "./data";

const DEFAULT_NAME = "ORIENTATION.md";

/** A file name with no folders in it: what the name box accepts. */
export function fileNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Enter a file name.";
  if (trimmed.includes("/") || trimmed.includes("\\")) return "A file name only: choose the folder above.";
  if (trimmed === "." || trimmed === "..") return "That is not a file name.";
  return null;
}

function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

function parentOf(dir: string): string {
  const cut = dir.lastIndexOf("/");
  return cut === -1 ? "" : dir.slice(0, cut);
}

/** The folder browser: the current folder with **Up**, then its folders (open) and files (take the name). */
function FolderPicker(props: { orientationId: string; dir: string; name: string; onDir(dir: string): void; onName(name: string): void }) {
  const { dir, name } = props;
  const folder = useOrientationFolder(props.orientationId, dir);
  const listing = folder.data?.dir === dir ? folder.data : undefined;
  const row = "flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left hover:bg-state-hover";
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex items-center gap-1.5">
        <Button type="button" size="sm" variant="ghost" aria-label="Up one folder" disabled={dir === ""} onClick={() => props.onDir(parentOf(dir))}>
          <Icon name="ArrowUp" />
        </Button>
        <span className="min-w-0 truncate font-mono" data-testid="export-folder">
          {dir === "" ? "Project root" : `${dir}/`}
        </span>
      </div>
      <ul aria-label="Folders and files" className="flex max-h-48 flex-col overflow-y-auto rounded-md border border-border p-1">
        {listing === undefined ? (
          <li className="px-2 py-1 text-muted-foreground">{folder.error !== null && folder.error !== undefined ? errorText(folder.error) : "Loading…"}</li>
        ) : listing.folders.length === 0 && listing.files.length === 0 ? (
          <li className="px-2 py-1 text-muted-foreground">This folder is empty.</li>
        ) : (
          <>
            {listing.folders.map((child) => (
              <li key={`d:${child}`}>
                <button type="button" className={row} onClick={() => props.onDir(joinPath(dir, child))}>
                  <Icon name="Folder" className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{child}</span>
                </button>
              </li>
            ))}
            {listing.files.map((child) => (
              <li key={`f:${child}`}>
                <button type="button" className={`${row} ${child === name.trim() ? "bg-state-active" : ""}`} aria-pressed={child === name.trim()} onClick={() => props.onName(child)}>
                  <Icon name="File" className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{child}</span>
                </button>
              </li>
            ))}
          </>
        )}
      </ul>
    </div>
  );
}

type Stage = { kind: "idle" } | { kind: "exists"; path: string; sha256: string } | { kind: "written"; path: string };

export function ExportDialog(props: { orientationId: string; onDone(): void }) {
  const rpc = useLearningRpc();
  const [dir, setDir] = useState("");
  const [name, setName] = useState(DEFAULT_NAME);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameError = fileNameError(name);
  const path = joinPath(dir, name.trim());

  async function run(target: string, replace: boolean, expectedSha256?: string) {
    setBusy(true);
    setError(null);
    try {
      const answer = await rpc.call("exportOrientation", {
        orientationId: props.orientationId,
        path: target,
        replace,
        ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
      });
      setStage("written" in answer ? { kind: "written", path: answer.written } : { kind: "exists", path: target, sha256: answer.sha256 });
    } catch (caught) {
      setError(errorText(caught));
      setStage({ kind: "idle" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-2 text-sm">
      {stage.kind === "written" ? (
        <>
          <p>Wrote {stage.path}.</p>
          <Button type="button" size="sm" variant="outline" className="self-start" onClick={props.onDone}>
            Done
          </Button>
        </>
      ) : stage.kind === "exists" ? (
        <>
          <p>{stage.path} already exists. Replace it?</p>
          <div className="flex gap-1.5">
            <Button type="button" size="sm" disabled={busy} onClick={() => void run(stage.path, true, stage.sha256)}>
              Replace
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={props.onDone}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <FolderPicker orientationId={props.orientationId} dir={dir} name={name} onDir={setDir} onName={setName} />
          <label className="flex flex-col gap-1 text-xs">
            File name
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <p className={`text-xs ${nameError === null ? "text-muted-foreground" : "text-destructive"}`}>{nameError ?? `Exports to ${path}`}</p>
          <div className="flex gap-1.5">
            <Button type="button" size="sm" disabled={busy || nameError !== null} onClick={() => void run(path, false)}>
              Export
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={props.onDone}>
              Cancel
            </Button>
          </div>
        </>
      )}
      {error !== null && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
