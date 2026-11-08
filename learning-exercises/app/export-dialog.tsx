/**
 * The export dialog: writes the orientation as Markdown at a workspace path (default `ORIENTATION.md`).
 * An existing file is never overwritten silently: the first call answers `{ exists: true, sha256 }`, the
 * dialog asks, and **Replace** sends `replace: true` with that hash as `expectedSha256`, so a file changed
 * while the user decided is refused (its message shows here and the dialog stays open to export again).
 * Every button is `type="button"`: the dialog may sit inside a form.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorText, useLearningRpc } from "./data";

const DEFAULT_PATH = "ORIENTATION.md";

type Stage = { kind: "idle" } | { kind: "exists"; sha256: string } | { kind: "written"; path: string };

export function ExportDialog(props: { orientationId: string; onDone(): void }) {
  const rpc = useLearningRpc();
  const [path, setPath] = useState(DEFAULT_PATH);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(replace: boolean, expectedSha256?: string) {
    setBusy(true);
    setError(null);
    try {
      const target = path.trim();
      const answer = await rpc.call("exportOrientation", {
        orientationId: props.orientationId,
        path: target,
        replace,
        ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
      });
      setStage("written" in answer ? { kind: "written", path: answer.written } : { kind: "exists", sha256: answer.sha256 });
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
          <p>{path.trim()} already exists. Replace it?</p>
          <div className="flex gap-1.5">
            <Button type="button" size="sm" disabled={busy} onClick={() => void run(true, stage.sha256)}>
              Replace
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={props.onDone}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-xs">
            Path in the project
            <Input value={path} onChange={(event) => setPath(event.target.value)} />
          </label>
          <div className="flex gap-1.5">
            <Button type="button" size="sm" disabled={busy || path.trim() === ""} onClick={() => void run(false)}>
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
