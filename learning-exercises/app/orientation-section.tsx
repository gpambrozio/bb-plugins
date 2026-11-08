/**
 * The Orientation section of the Learning tab: the project's orientation (a repository summary and,
 * optionally, a walkthrough) and the buttons around it. One section per thread, reading the project's
 * state from the `orientation` RPC:
 *
 * - none: **Orient me to this project**, with a "Include a walkthrough" checkbox and what the background
 *   agent is allowed to do;
 * - live: "Building · N blocks · M min" and **Cancel**; a rebuild of a ready orientation keeps the
 *   ready summary below it;
 * - failed or cancelled (`last`): its error and **Rebuild**, above the ready summary when there is one;
 * - ready: the summary (the purpose open, the rest folded) and its buttons.
 *
 * **Export to repo…** only toggles `exportOpen` here; the export dialog is rendered where it is checked.
 */
import { experimental_useAppPanel, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { Orientation, OrientationSummary } from "../shared/orientation";
import { errorText, useLearningRpc, useOrientation } from "./data";
import { FileRef, TextWithFileRefs } from "./file-refs";
import { ORIENTATION_TAB_ID } from "./orientation-ids";
import { Section, useAct } from "./tab";

const PERMISSION_LINE = "A background agent reads this project for a few minutes in this checkout. bb gives it permission to read and edit files; it is told not to edit anything.";

type OrientationState = NonNullable<ReturnType<typeof useOrientation>["data"]>;

function minutesSince(at: number): number {
  return Math.max(0, Math.floor((Date.now() - at) / 60_000));
}

/** A folded part of the summary, opened by its heading. */
function Fold(props: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <Button type="button" size="sm" variant="ghost" className="self-start" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        {props.title}
      </Button>
      {open && <div className="flex flex-col gap-1 pl-2 text-xs">{props.children}</div>}
    </div>
  );
}

function SummaryView(props: { summary: OrientationSummary; environmentId: string | null }) {
  const { summary, environmentId } = props;
  return (
    <div className="flex flex-col gap-1">
      <p>{summary.purpose}</p>
      <Fold title="Languages">
        <span>{summary.languages.join(", ")}</span>
      </Fold>
      <Fold title="Stages">
        <ol className="list-decimal pl-4">
          {summary.stages.map((stage, index) => (
            <li key={index}>{stage}</li>
          ))}
        </ol>
      </Fold>
      <Fold title="Key files">
        <ul className="flex flex-col gap-1">
          {summary.keyFiles.map((file) => (
            <li key={file.path}>
              <FileRef reference={file.path} environmentId={environmentId} /> <span className="text-muted-foreground">{file.does}</span>
              <div className="text-muted-foreground">{file.why}</div>
            </li>
          ))}
        </ul>
      </Fold>
      <Fold title="Concepts">
        <ul className="flex flex-col gap-1">
          {summary.concepts.map((concept) => (
            <li key={concept.name}>
              <span className="font-medium">{concept.name}</span>: {concept.definition}{" "}
              <span className="text-muted-foreground">
                (<TextWithFileRefs text={`\`${concept.where}\``} environmentId={environmentId} />)
              </span>
            </li>
          ))}
        </ul>
      </Fold>
      <Fold title="Gotchas">
        <ul className="list-disc pl-4">
          {summary.gotchas.map((gotcha, index) => (
            <li key={index}>{gotcha}</li>
          ))}
        </ul>
      </Fold>
    </div>
  );
}

function ReadyBlock(props: { threadId: string; orientation: Orientation; building: boolean; startable: boolean }) {
  const { threadId, orientation } = props;
  const rpc = useLearningRpc();
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const { busy, act } = useAct();
  const [confirming, setConfirming] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const environmentId = orientation.workspace?.environmentId ?? null;
  return (
    <div className="flex flex-col gap-2">
      {orientation.summary !== null && <SummaryView summary={orientation.summary} environmentId={environmentId} />}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          disabled={busy !== null}
          onClick={() =>
            void act("session", async () => {
              const { threadId: sessionThread } = await rpc.call("startOrientationSession", { threadId, orientationId: orientation.id });
              navigate.toThread(sessionThread);
            })
          }
        >
          Start orientation session
        </Button>
        {orientation.blocks > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => panel.openTab({ tab: { id: ORIENTATION_TAB_ID, context: { kind: "thread" }, availability: "action" }, params: { orientationId: orientation.id } })}
          >
            Read walkthrough
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={() =>
            void act("verify", async () => {
              const { checked, drift } = await rpc.call("verifyOrientation", { orientationId: orientation.id });
              toast(drift.length === 0 ? `Checked ${checked} listings; none have drifted.` : `Checked ${checked} listings; ${drift.length} drifted: ${drift.join(", ")}`);
            })
          }
        >
          Verify
        </Button>
        <Button type="button" size="sm" variant="ghost" aria-expanded={exportOpen} onClick={() => setExportOpen((open) => !open)}>
          Export to repo…
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy !== null || props.building || !props.startable}
          onClick={() => void act("rebuild", () => rpc.call("startOrientation", { threadId, depth: orientation.depth }))}
        >
          Rebuild
        </Button>
        {confirming ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy !== null}
              onClick={() =>
                void act("delete", async () => {
                  await rpc.call("deleteOrientation", { orientationId: orientation.id });
                  setConfirming(false);
                })
              }
            >
              Delete it
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirming(true)}>
            Delete
          </Button>
        )}
      </div>
      {/* The export dialog (a later task) renders here while `exportOpen` is set. */}
    </div>
  );
}

function StartBlock(props: { threadId: string; state: OrientationState }) {
  const rpc = useLearningRpc();
  const { busy, act } = useAct();
  const [walkthrough, setWalkthrough] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" checked={walkthrough} onChange={(event) => setWalkthrough(event.target.checked)} />
        Include a walkthrough
      </label>
      <Button
        type="button"
        size="sm"
        className="self-start"
        disabled={busy !== null || props.state.cleaning || !props.state.canStart}
        onClick={() => void act("start", () => rpc.call("startOrientation", { threadId: props.threadId, depth: walkthrough ? "walkthrough" : "summary" }))}
      >
        Orient me to this project
      </Button>
      {props.state.cleaning && <p className="text-xs text-muted-foreground">Cleaning up after an earlier run; a new orientation can start in a moment.</p>}
      <p className="text-xs text-muted-foreground">{PERMISSION_LINE}</p>
    </div>
  );
}

export function OrientationSection(props: { threadId: string; visible: boolean }) {
  const { threadId } = props;
  const query = useOrientation(threadId, props.visible);
  const rpc = useLearningRpc();
  const { busy, act } = useAct();
  const state = query.data;
  if (state === undefined) {
    return query.error === null || query.error === undefined ? null : (
      <Section title="Orientation">
        <p className="text-xs text-destructive">Learning Exercises: {errorText(query.error)}</p>
      </Section>
    );
  }
  const { current, live, last } = state;
  const startable = state.canStart && !state.cleaning;
  return (
    <Section title="Orientation">
      {live !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">
            Building · {live.blocks} blocks · {minutesSince(live.createdAt)} min
          </span>
          <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void act("cancel", () => rpc.call("cancelOrientation", { orientationId: live.id }))}>
            Cancel
          </Button>
        </div>
      )}
      {last !== null && live === null && (
        <div className="flex flex-col gap-1.5 rounded-md border border-warning p-2 text-xs">
          <span className="text-warning-text">
            The last orientation {last.status === "cancelled" ? "was cancelled" : "failed"}
            {last.error !== null ? `: ${last.error}` : "."}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            disabled={busy !== null || !startable}
            onClick={() => void act("retry", () => rpc.call("startOrientation", { threadId, depth: last.depth }))}
          >
            {current === null ? "Rebuild" : "Try again"}
          </Button>
        </div>
      )}
      {current !== null ? (
        <ReadyBlock threadId={threadId} orientation={current} building={live !== null} startable={startable} />
      ) : live === null && last === null ? (
        <StartBlock threadId={threadId} state={state} />
      ) : null}
    </Section>
  );
}
