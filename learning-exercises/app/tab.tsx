/**
 * The Learning tab (feature #9), in a thread's side panel. Top to bottom:
 *
 * - **Now**: this thread's offer, or the session it hosts or started, with Pause / Resume / Finish, and
 *   its questions so far with the learner's answers and the agent's feedback.
 * - **Start**: an exercise on this thread's work, on a topic taken from data (the last commit, the last
 *   turn's new files, the thread's title) or typed.
 * - **Paused** and **Previous**: this project's sessions, with Resume, the learner's own answers, and
 *   delete.
 * - The footer: offers in this thread on or off, "Never for this project" (with Undo), and the settings.
 *
 * The tab is fixed, on the tab bar, in every thread bb lists in the sidebar: top-level threads, child
 * and sub-agent threads, other plugins' threads, and this plugin's own session threads. Hidden threads
 * are not listed, so they get none. Offers are made only in top-level threads a person drives (the
 * server's `isHumanThread`); elsewhere the tab is there for Start and Resume by hand, with that thread
 * as the source (`canStartByHand`, which also keeps Start out of a session's own thread).
 *
 * Earlier builds put the tab in sub-agent threads only as an action tab (`LEARNING_ON_DEMAND_TAB`) added
 * from the side panel's launcher. bb keeps an action tab's instances with the thread, so that tab stays
 * registered, never offered, and `useOneLearningTab` closes any instance still open.
 */
import {
  experimental_useAppPanel,
  experimental_usePanelTabs,
  experimental_useTabVisible,
  useBbNavigate,
  type ExperimentalPanelTab,
  type ExperimentalTabReference,
  type ExperimentalThreadTabProps,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { CONFIDENCE_LABELS, PLUGIN_ID, TRIGGER_LABELS, type Session, type ThreadView, type TopicChoice } from "../shared/types";
import { AnswerView } from "./answer-form";
import { errorText, useLearningRpc, useProjectSessions, useSessionDetail, useSidebarThread, useThreadView, useTopicChoices } from "./data";
import { FileMarkdown, TextWithFileRefs } from "./file-refs";
import { OfferCard } from "./offer-card";
import { openSettings } from "./open-settings";

export { PLUGIN_ID };
export const UPSTREAM_URL = "https://github.com/DrCatHicks/learning-opportunities";

/** The fixed Learning tab, as the panel controller addresses it. */
export const LEARNING_FIXED_TAB = { id: "learning", context: { kind: "thread" }, availability: "fixed" } as const satisfies ExperimentalTabReference;

/** The on-demand Learning tab, as the panel controller addresses it. */
export const LEARNING_ON_DEMAND_TAB = { id: "learning-on-demand", context: { kind: "thread" }, availability: "action" } as const satisfies ExperimentalTabReference;

type SidebarThreadRow = NonNullable<ReturnType<typeof useSidebarThread>>;

/** The fixed tab shows in every thread the sidebar lists, which leaves out hidden threads. */
export function useLearningTabVisible({ threadId }: ExperimentalThreadTabProps): boolean {
  return useSidebarThread(threadId) !== undefined;
}

/** The retired on-demand tab is never offered in the launcher; it is registered only to close leftovers. */
export function useLearningOnDemandVisible(_props: ExperimentalThreadTabProps): boolean {
  return false;
}

function isOnDemandInstance(tab: ExperimentalPanelTab): boolean {
  return tab.detail.kind === "plugin" && tab.detail.pluginId === PLUGIN_ID && tab.detail.tab.id === LEARNING_ON_DEMAND_TAB.id;
}

/**
 * Keeps one Learning tab per thread. bb keeps an action tab's open instances, persisted with the thread,
 * even once its `useVisible` is false, so an on-demand instance an earlier build opened would sit beside
 * the fixed tab. Once the thread's row is known (and the fixed tab shows), close every on-demand instance
 * in this thread view's panel, and if one was the selected tab of an open panel, select the fixed tab
 * first so the learner stays on Learning. Runs from the composer banner, which is mounted whenever the
 * thread's composer is, and from the on-demand tab itself.
 */
export function useOneLearningTab(thread: SidebarThreadRow | undefined): void {
  const panel = experimental_useAppPanel();
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const { open, selectedKey, tabs } = experimental_usePanelTabs();
  const stale = thread !== undefined ? tabs.filter(isOnDemandInstance).map((tab) => tab.key) : [];
  const staleKeys = stale.join("\n");
  const moveSelection = open && selectedKey !== null && stale.includes(selectedKey);
  useEffect(() => {
    if (staleKeys === "") return;
    if (moveSelection) panelRef.current.openTab({ tab: LEARNING_FIXED_TAB });
    for (const key of staleKeys.split("\n")) panelRef.current.closeTab(key);
  }, [staleKeys, moveSelection]);
}

/** A leftover on-demand tab: the Learning tab, which hands itself over to the fixed one and closes. */
export function LearningOnDemandTab(props: ExperimentalThreadTabProps & { params: unknown }) {
  useOneLearningTab(useSidebarThread(props.threadId));
  return <LearningTab threadId={props.threadId} environment={props.environment} />;
}

const STATE_LABELS: Record<Session["state"], string> = {
  starting: "Starting",
  active: "In progress",
  "awaiting-answer": "Waiting for your answer",
  paused: "Paused",
  finished: "Finished",
  abandoned: "Not finished",
};

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function plain(topic: string): string {
  return topic.replace(/[`"]/g, "");
}

function Section(props: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{props.title}</h3>
        {props.aside}
      </div>
      {props.children}
    </section>
  );
}

/** Runs a write with a toast on failure; answers its result, or undefined when it failed. */
function useAct() {
  const [busy, setBusy] = useState<string | null>(null);
  const act = async <T,>(key: string, work: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key);
    try {
      return await work();
    } catch (error) {
      toast.error(`Learning Exercises: ${errorText(error)}`);
      return undefined;
    } finally {
      setBusy(null);
    }
  };
  return { busy, act };
}

function SessionControls(props: { session: Session; currentThreadId: string }) {
  const { session, currentThreadId } = props;
  const rpc = useLearningRpc();
  const navigate = useBbNavigate();
  const { busy, act } = useAct();
  const open = session.state !== "finished" && session.state !== "abandoned";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {session.state === "paused" ? (
        <Button
          type="button"
          size="sm"
          disabled={busy !== null}
          onClick={() =>
            void act("resume", async () => {
              const { threadId } = await rpc.call("resumeSession", { sessionId: session.id });
              if (threadId !== "" && threadId !== currentThreadId) navigate.toThread(threadId);
            })
          }
        >
          <Icon name="Play" /> Resume
        </Button>
      ) : (
        open && (
          <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void act("pause", () => rpc.call("pauseSession", { sessionId: session.id }))}>
            <Icon name="Pause" /> Pause
          </Button>
        )
      )}
      {open && (
        <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act("finish", () => rpc.call("finishSession", { sessionId: session.id }))}>
          Finish
        </Button>
      )}
      {session.threadId !== null && session.threadId !== currentThreadId && (
        <Button type="button" size="sm" variant="ghost" onClick={() => navigate.toThread(session.threadId!)}>
          Open session thread
        </Button>
      )}
      {session.mode === "fork" && session.sourceThreadId !== null && session.sourceThreadId !== currentThreadId && (
        <Button type="button" size="sm" variant="ghost" onClick={() => navigate.toThread(session.sourceThreadId!)}>
          Open source thread
        </Button>
      )}
    </div>
  );
}

function SessionSummary(props: { session: Session; environmentId: string | null }) {
  const { session } = props;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium">
        <TextWithFileRefs text={session.topic.replace(/"/g, "")} environmentId={props.environmentId} />
      </span>
      <span className="text-xs text-muted-foreground">
        {STATE_LABELS[session.state]} · {session.answered} of {session.asked} answered · {session.mode === "fork" ? "side thread" : "in its thread"}
        {session.state === "paused" && session.pauseReason !== null ? ` · ${session.pauseReason}` : ""}
      </span>
    </div>
  );
}

/** The open session's questions so far, with the answers and the agent's feedback; folded until asked for. */
function SoFar(props: { session: Session }) {
  const [open, setOpen] = useState(false);
  if (props.session.asked === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <Button type="button" size="sm" variant="ghost" className="self-start" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <Icon name={open ? "ChevronUp" : "ChevronDown"} /> Questions and feedback so far ({props.session.asked})
      </Button>
      {open && <ExerciseList sessionId={props.session.id} />}
    </div>
  );
}

function Now(props: { view: ThreadView; threadId: string; visible: boolean }) {
  const { view, threadId } = props;
  const session = view.hosted ?? view.started;
  if (session !== null) {
    return (
      <Section title={view.hosted !== null ? "This session" : "Session from this thread"}>
        <SessionSummary session={session} environmentId={view.workspace?.environmentId ?? null} />
        <SessionControls session={session} currentThreadId={threadId} />
        <SoFar session={session} />
      </Section>
    );
  }
  if (view.offer !== null) {
    return (
      <Section title="Now">
        <OfferCard offer={view.offer} threadId={threadId} onScreen={props.visible} where="tab" sessionWhere={view.sessionWhere} environmentId={view.workspace?.environmentId ?? null} />
      </Section>
    );
  }
  return null;
}

function Start(props: { threadId: string; view: ThreadView; visible: boolean }) {
  const rpc = useLearningRpc();
  const navigate = useBbNavigate();
  const choices = useTopicChoices(props.threadId, props.visible);
  const [picked, setPicked] = useState<string>("");
  const [typed, setTyped] = useState("");
  const { busy, act } = useAct();
  const list: readonly TopicChoice[] = choices.data?.choices ?? [];
  const selected = list.find((choice) => choice.id === picked) ?? (picked === "" ? list[0] : undefined);
  const topic = picked === "typed" ? typed.trim() : (selected?.topic ?? "");
  const start = (here: boolean) =>
    void act(here ? "here" : "start", async () => {
      const chosen = picked === "typed" || selected === undefined ? { topic, trigger: "manual" as const, refs: {} } : { topic: selected.topic, trigger: selected.trigger, refs: selected.refs };
      const { threadId } = await rpc.call("startSession", { threadId: props.threadId, ...chosen, here });
      if (threadId !== props.threadId) navigate.toThread(threadId);
    });
  return (
    <Section title="Start an exercise">
      <p className="text-xs text-muted-foreground">About 10–15 minutes on this thread's work. Pick a topic:</p>
      <div className="flex flex-col gap-1" role="radiogroup" aria-label="Topic">
        {list.map((choice, index) => (
          <label key={choice.id} className="flex cursor-pointer items-start gap-2 text-sm">
            <input type="radio" name="topic" className="mt-1" checked={picked === choice.id || (picked === "" && index === 0)} onChange={() => setPicked(choice.id)} />
            <span className="min-w-0 break-words">{plain(choice.label)}</span>
          </label>
        ))}
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="radio" name="topic" checked={picked === "typed" || (picked === "" && list.length === 0)} onChange={() => setPicked("typed")} />
          <Input
            aria-label="Your own topic"
            placeholder="Your own topic"
            value={typed}
            className="h-8"
            onFocus={() => setPicked("typed")}
            onChange={(event) => {
              setPicked("typed");
              setTyped(event.target.value);
            }}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" size="sm" disabled={busy !== null || topic === ""} onClick={() => start(false)}>
          {busy === "start" ? "Starting…" : props.view.sessionWhere === "fork" ? "Start in a side thread" : "Start here"}
        </Button>
        {props.view.sessionWhere === "fork" && (
          <Button type="button" size="sm" variant="ghost" disabled={busy !== null || topic === ""} onClick={() => start(true)}>
            Run it in this thread
          </Button>
        )}
      </div>
    </Section>
  );
}

function ExerciseList(props: { sessionId: string }) {
  const detail = useSessionDetail(props.sessionId);
  const exercises = detail.data?.exercises ?? [];
  const workspace = detail.data?.workspace ?? null;
  if (detail.isLoading) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (exercises.length === 0) return <p className="text-xs text-muted-foreground">No questions were asked.</p>;
  return (
    <ol className="flex flex-col gap-2">
      {exercises.map((exercise) => (
        <li key={exercise.ordinal} className="flex flex-col gap-1 border-l-2 border-border pl-2 text-xs">
          <FileMarkdown content={exercise.question} workspace={workspace} className="text-xs text-muted-foreground" />
          {exercise.answer !== null && exercise.form !== null && exercise.fields !== null ? (
            <AnswerView form={exercise.form} fields={exercise.fields} workspace={workspace} />
          ) : exercise.answer !== null ? (
            <span className="whitespace-pre-wrap">{exercise.answer}</span>
          ) : (
            <span className="text-muted-foreground">{exercise.stuck > 0 ? "Asked for a more specific question." : exercise.skipped ? "Skipped." : "Not answered."}</span>
          )}
          <span className="text-muted-foreground">
            {exercise.confidence !== null ? `Confidence ${exercise.confidence}/5 (${CONFIDENCE_LABELS[exercise.confidence]})` : ""}
            {exercise.verdict !== null ? ` · ${exercise.verdict}` : ""}
            {exercise.gap !== null ? ` · ${exercise.gap}` : ""}
          </span>
          {exercise.reply !== null && (
            <div className="flex flex-col gap-0.5 rounded-md border border-border px-2 py-1.5">
              <span className="font-medium text-muted-foreground">{exercise.answer !== null ? "Feedback" : "After this question"}</span>
              <FileMarkdown content={exercise.reply} workspace={workspace} className="text-xs" />
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

function SessionRow(props: { session: Session; currentThreadId: string }) {
  const { session } = props;
  const rpc = useLearningRpc();
  const navigate = useBbNavigate();
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { busy, act } = useAct();
  return (
    <li className="flex flex-col gap-1.5 rounded-md border border-border p-2 text-sm">
      <button type="button" className="flex items-start justify-between gap-2 text-left" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium">{plain(session.topic)}</span>
          <span className="text-xs text-muted-foreground">
            {when(session.finishedAt ?? session.updatedAt)} · {TRIGGER_LABELS[session.trigger]} · {session.answered} of {session.asked} answered
            {session.state === "paused" && session.pauseReason !== null ? ` · ${session.pauseReason}` : ""}
            {session.state === "abandoned" ? " · not finished" : ""}
          </span>
        </div>
        <Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      </button>
      {expanded && (
        <>
          {session.summary !== null && <p className="text-xs">{session.summary}</p>}
          <ExerciseList sessionId={session.id} />
          <div className="flex flex-wrap gap-1.5">
            {session.state === "paused" && <SessionControls session={session} currentThreadId={props.currentThreadId} />}
            {session.state !== "paused" && session.threadId !== null && (
              <Button type="button" size="sm" variant="ghost" onClick={() => navigate.toThread(session.threadId!)}>
                Open thread
              </Button>
            )}
            {confirming ? (
              <>
                <Button type="button" size="sm" variant="destructive" disabled={busy !== null} onClick={() => void act("delete", () => rpc.call("deleteSession", { sessionId: session.id }))}>
                  Delete it and its answers
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirming(true)}>
                Delete…
              </Button>
            )}
          </div>
        </>
      )}
    </li>
  );
}

function Lists(props: { threadId: string; visible: boolean }) {
  const [limit, setLimit] = useState(20);
  const sessions = useProjectSessions(props.threadId, limit, props.visible);
  const data = sessions.data;
  if (data === undefined) return null;
  return (
    <>
      {data.paused.length > 0 && (
        <Section title="Paused">
          <ul className="flex flex-col gap-1.5">
            {data.paused.map((session) => (
              <SessionRow key={session.id} session={session} currentThreadId={props.threadId} />
            ))}
          </ul>
        </Section>
      )}
      <Section title="Previous">
        {data.previous.length === 0 ? (
          <p className="text-xs text-muted-foreground">No sessions in this project yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {data.previous.map((session) => (
              <SessionRow key={session.id} session={session} currentThreadId={props.threadId} />
            ))}
          </ul>
        )}
        {data.hasMore && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setLimit((current) => current + 20)}>
            More
          </Button>
        )}
      </Section>
    </>
  );
}

function Footer(props: { view: ThreadView; threadId: string }) {
  const { view, threadId } = props;
  const rpc = useLearningRpc();
  const { busy, act } = useAct();
  return (
    <footer className="flex flex-col gap-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
      {view.offersOffGlobally ? (
        <span>Offers are turned off in the plugin's settings; you can still start a session above.</span>
      ) : view.projectNever ? (
        <span className="flex flex-wrap items-center gap-1.5">
          No offers in {view.projectName}.
          <Button type="button" size="sm" variant="link" className="h-auto p-0 text-xs" disabled={busy !== null} onClick={() => void act("never", () => rpc.call("setProjectNever", { threadId, never: false }))}>
            Undo
          </Button>
        </span>
      ) : (
        view.eligible && (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={view.offersOn} disabled={busy !== null} onChange={(event) => void act("offers", () => rpc.call("setThreadOffers", { threadId, on: event.target.checked }))} />
              Offers in this thread
            </label>
            <Button type="button" size="sm" variant="link" className="h-auto p-0 text-xs" disabled={busy !== null} onClick={() => void act("never", () => rpc.call("setProjectNever", { threadId, never: true }))}>
              Never in {view.projectName}
            </Button>
          </span>
        )
      )}
      <Button
        type="button"
        size="sm"
        variant="link"
        className="h-auto self-start p-0 text-xs"
        onClick={() => {
          if (!openSettings(window)) toast("Learning Exercises' settings are in Settings → Plugins.");
        }}
      >
        Settings
      </Button>
    </footer>
  );
}

export function LearningTab({ threadId }: ExperimentalThreadTabProps) {
  const visible = experimental_useTabVisible();
  const navigate = useBbNavigate();
  const view = useThreadView(threadId, visible);
  if (view.error !== null && view.data === undefined) return <p className="p-3 text-sm text-destructive">Learning Exercises: {view.error.message}</p>;
  if (view.data === undefined) return <p className="p-3 text-sm text-muted-foreground">Loading…</p>;
  const data = view.data;
  const sessionOpen = data.hosted !== null || data.started !== null;
  return (
    <div className="flex flex-col gap-5 text-sm">
      <Now view={data} threadId={threadId} visible={visible} />
      {data.canStart && !sessionOpen && <Start threadId={threadId} view={data} visible={visible} />}
      <Lists threadId={threadId} visible={visible} />
      <Footer view={data} threadId={threadId} />
      <p className="text-[11px] leading-snug text-muted-foreground">
        Exercises adapted from Dr. Cat Hicks's{" "}
        <button type="button" className="underline underline-offset-2" onClick={() => navigate.openUrl(UPSTREAM_URL)}>
          Learning Opportunities
        </button>{" "}
        (CC BY 4.0). Not affiliated.
      </p>
    </div>
  );
}
