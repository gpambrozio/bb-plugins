/**
 * The first-run guide: a toast that offers it to a new install, and the three-step setup it opens —
 * the first mate's home folder, its model and machine, and the start. Starting launches the first mate
 * with the first-session prompt (`intro.start`), opens its thread in place of the current view, and opens
 * the FirstMate tab beside it.
 *
 * Whether to offer it is the server's (`server/intro.ts`); "Later" is this window's (`intro-store.ts`).
 * Everything here lives in one app overlay, so the dialog can open over any page.
 */
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useRpcQuery,
  useBbNavigate,
  useComposer,
  useRpc,
  useSdk,
  type BbNavigate,
  type ExperimentalProviderModelPickerValue,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import type { rpcContract as RpcContract } from "../server";
import { rpcContract } from "../shared/contract";
import { useAppPanel } from "./app-panel";
import { PANEL_ACTION_ID } from "./commands";
import { introStore } from "./intro-store";
import { findLocalHostId, isDesktopApp } from "./local-host";
import { errorText, reportError } from "./notify";
import { useDefaultPick } from "./use-default-pick";

/**
 * The offer's toast id. It is this loaded copy's own, because a reload mounts the new copy before the old
 * one unmounts, and the old one's clean-up must not dismiss the toast the new one has just shown.
 */
export const INTRO_TOAST_ID = `firstmate-intro-${Math.random().toString(36).slice(2, 10)}`;

export const INTRO_TOAST_TITLE = "Start using FirstMate?";

/** The home setting's default, for a dialog opened before the status has loaded. */
const DEFAULT_HOME = "~/FirstMate";

/** How long the guide keeps trying to open the FirstMate tab after the first mate's thread is shown. */
const BOARD_OPEN_WINDOW_MS = 5_000;
const BOARD_OPEN_RETRY_MS = 250;

function useIntroWindow() {
  return useSyncExternalStore(introStore.subscribe, introStore.get);
}

/** One machine, as the guide's second step lists it. */
export interface MachineChoice {
  id: string;
  name: string;
  connected: boolean;
  /** The machine bb runs on, where the first mate's home must be. */
  isServer: boolean;
}

interface Machines {
  list: MachineChoice[];
  /** This window's own machine, when it is bb's desktop app; for the Browse button. */
  localHostId: string | null;
  error: string | null;
}

/** The machines bb knows, the bb server's marked, and the machine this window runs on. */
function useMachines(): Machines {
  const sdk = useSdk();
  const [machines, setMachines] = useState<Machines>({ list: [], localHostId: null, error: null });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [config, hosts] = await Promise.all([sdk.system.config(), sdk.hosts.list()]);
      const list = hosts.map((host) => ({
        id: host.id,
        name: host.name,
        connected: host.status === "connected",
        isServer: host.id === config.primaryHostId,
      }));
      list.sort((a, b) => Number(b.isServer) - Number(a.isServer) || a.name.localeCompare(b.name));
      const localHostId = isDesktopApp() ? await findLocalHostId(config.localHelperPorts, window.location.origin) : null;
      if (!cancelled) setMachines({ list, localHostId, error: null });
    })().catch((caught: unknown) => {
      if (!cancelled) setMachines({ list: [], localHostId: null, error: errorText(caught) });
    });
    return () => {
      cancelled = true;
    };
  }, [sdk]);
  return machines;
}

type Step = "home" | "agent" | "start";

const STEPS: readonly Step[] = ["home", "agent", "start"];

const STEP_TITLES: Record<Step, string> = {
  home: "Where should the first mate live?",
  agent: "Which model, on which machine?",
  start: "Ready to start",
};

/** A home folder the server will take: absolute, or under `~`. */
export function looksLikeHome(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("/");
}

function StepHome({
  home,
  onChange,
  serverMachine,
  canBrowse,
  onBrowse,
}: {
  home: string;
  onChange: (value: string) => void;
  serverMachine: string | null;
  canBrowse: boolean;
  onBrowse: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">
        Your first mate keeps its charter, backlog and notes in a folder of its own
        {serverMachine === null ? "" : ` on ${serverMachine}`}, and FirstMate adds it to bb as the FirstMate project. Use a
        new or empty folder; it is created if it does not exist.
      </p>
      <label className="flex flex-col gap-1.5">
        <span className="font-medium">Home folder</span>
        <div className="flex gap-2">
          <Input
            aria-label="Home folder"
            value={home}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            onChange={(event) => onChange(event.target.value)}
          />
          {canBrowse ? (
            <Button type="button" variant="outline" onClick={onBrowse}>
              Browse…
            </Button>
          ) : null}
        </div>
      </label>
      {looksLikeHome(home) ? null : (
        <p role="status" className="text-xs text-destructive">
          Use a full path, or one starting with ~ for your home folder.
        </p>
      )}
    </div>
  );
}

function StepAgent({
  pick,
  pickError,
  onPick,
  machines,
}: {
  pick: ExperimentalProviderModelPickerValue | null;
  pickError: string | null;
  onPick: (value: ExperimentalProviderModelPickerValue) => void;
  machines: Machines;
}) {
  const others = machines.list.filter((machine) => !machine.isServer);
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-col gap-1.5">
        <span className="font-medium">Model</span>
        <p className="text-muted-foreground">The agent that will be your first mate. You can change your crew's model later in settings.</p>
        <div>
          {pick === null ? (
            <span className="text-muted-foreground">{pickError ?? "Loading models…"}</span>
          ) : (
            <ProviderModelPicker value={pick} onChange={onPick} />
          )}
        </div>
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 font-medium">Machine</legend>
        {machines.error !== null ? <p className="text-xs text-destructive">{machines.error}</p> : null}
        {machines.list.length === 0 && machines.error === null ? <p className="text-muted-foreground">Loading machines…</p> : null}
        {machines.list.map((machine) => (
          <label
            key={machine.id}
            className={`flex items-center gap-2 rounded-md border border-border px-3 py-2 ${machine.isServer ? "" : "text-muted-foreground"}`}
          >
            <input type="radio" name="firstmate-machine" checked={machine.isServer} disabled={!machine.isServer} readOnly />
            <span className="font-medium">{machine.name}</span>
            <span className="text-xs text-muted-foreground">
              {machine.isServer ? "runs bb" : machine.connected ? "for crew only" : "offline"}
            </span>
          </label>
        ))}
        <p className="text-xs text-muted-foreground">
          {others.length === 0
            ? "The first mate runs on the machine bb runs on, beside its home folder."
            : "The first mate runs on the machine bb runs on, beside its home folder. Your crew can still work in projects on your other machines."}
        </p>
      </fieldset>
    </div>
  );
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all font-medium">{children}</dd>
    </div>
  );
}

function StepStart({ home, pick, machine, error }: { home: string; pick: ExperimentalProviderModelPickerValue | null; machine: string | null; error: string | null }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <dl className="flex flex-col gap-2 rounded-md border border-border bg-card p-3 text-card-foreground">
        <SummaryRow label="Home">
          <span className="font-mono">{home.trim()}</span>
        </SummaryRow>
        <SummaryRow label="Model">{pick === null ? "—" : `${pick.providerId} · ${pick.model}`}</SummaryRow>
        <SummaryRow label="Machine">{machine ?? "—"}</SummaryRow>
      </dl>
      <p className="text-muted-foreground">
        FirstMate starts your first mate, opens its chat beside this view with the FirstMate board, and the first mate walks
        you through your first session: what it does, your first project, and a first small task.
      </p>
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The three-step setup. `onStarted` gets the new first mate's thread id. It is mounted only while open,
 * so every opening starts over at the first step, from the setting as it is then.
 */
export function IntroDialog({
  onClose,
  initialHome,
  onStarted,
}: {
  onClose: () => void;
  initialHome: string;
  onStarted: (threadId: string) => void;
}) {
  const rpc = useRpc<typeof RpcContract>();
  const sdk = useSdk();
  const initial = useDefaultPick();
  const machines = useMachines();
  const [step, setStep] = useState<Step>("home");
  const [home, setHome] = useState(initialHome);
  const [chosen, setChosen] = useState<ExperimentalProviderModelPickerValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = chosen ?? initial.pick;
  const server = machines.list.find((machine) => machine.isServer) ?? null;
  const canBrowse = server !== null && machines.localHostId === server.id;
  const index = STEPS.indexOf(step);

  function browse(): void {
    if (server === null || machines.localHostId === null) return;
    sdk.hosts
      .pickFolder({ hostId: server.id, clientHostId: machines.localHostId })
      .then(({ path }) => {
        if (path !== null) setHome(path);
      })
      .catch(reportError);
  }

  function start(): void {
    if (pick === null) return;
    setBusy(true);
    setError(null);
    rpc
      .call("intro.start", {
        homeDirectory: home.trim(),
        providerId: pick.providerId,
        model: pick.model,
        ...(pick.reasoningLevel === undefined ? {} : { reasoningLevel: pick.reasoningLevel }),
      })
      .then(({ threadId }) => onStarted(threadId))
      .catch((caught: unknown) => setError(errorText(caught)))
      .finally(() => setBusy(false));
  }

  const canNext = step === "home" ? looksLikeHome(home) : step === "agent" ? pick !== null && server !== null : false;

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <p className="text-xs font-medium text-muted-foreground">
            Set up FirstMate · Step {index + 1} of {STEPS.length}
          </p>
          <DialogTitle>{STEP_TITLES[step]}</DialogTitle>
          <DialogDescription className="sr-only">
            Choose the first mate&apos;s home folder, model and machine, then start it.
          </DialogDescription>
        </DialogHeader>
        {step === "home" ? (
          <StepHome home={home} onChange={setHome} serverMachine={server?.name ?? null} canBrowse={canBrowse} onBrowse={browse} />
        ) : step === "agent" ? (
          <StepAgent pick={pick} pickError={initial.error} onPick={setChosen} machines={machines} />
        ) : (
          <StepStart home={home} pick={pick} machine={server?.name ?? null} error={error} />
        )}
        <DialogFooter className="gap-2">
          {index > 0 ? (
            <Button type="button" variant="outline" disabled={busy} onClick={() => setStep(STEPS[index - 1]!)}>
              Back
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
          )}
          {step === "start" ? (
            <Button type="button" disabled={busy || pick === null} onClick={start}>
              {busy ? "Starting…" : "Start the first mate"}
            </Button>
          ) : (
            <Button type="button" disabled={!canNext} onClick={() => setStep(STEPS[index + 1]!)}>
              Next
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Opens the FirstMate tab in the first mate's thread once its composer is on screen, the guide having
 * just opened the thread (`showFirstMate`). A composer contribution that draws nothing, because only a
 * component inside the thread's view gets that view's panel controller: an app overlay's opens no pane's.
 * bb mounts the pane a moment after the guide asks for it, so it tries again briefly.
 */
export function BoardOpener() {
  const { boardFor } = useIntroWindow();
  const { scope } = useComposer();
  const panel = useAppPanel();
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const threadId = scope?.kind === "thread" ? scope.threadId : null;

  useEffect(() => {
    if (boardFor === null || threadId !== boardFor) return;
    // bb 0.47 has no panel controller: the thread is open, and the captain opens the tab from its panel.
    if (panelRef.current === null) {
      introStore.showBoardFor(null);
      return;
    }
    const deadline = Date.now() + BOARD_OPEN_WINDOW_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = () => {
      const opened = panelRef.current?.openTab({ tab: { id: PANEL_ACTION_ID, context: { kind: "thread" }, availability: "action" } });
      if (opened === true || Date.now() > deadline) {
        introStore.showBoardFor(null);
        return;
      }
      timer = setTimeout(attempt, BOARD_OPEN_RETRY_MS);
    };
    attempt();
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [boardFor, threadId]);
  return null;
}

/**
 * The guide's end: the first mate's thread in place of the view the guide was started from, with the
 * FirstMate tab beside it (`BoardOpener`). Plain navigation, never `split`: a split keeps that view as a
 * pane of its own, and on a new install that is an empty New thread screen.
 */
export function showFirstMate(navigate: Pick<BbNavigate, "toThread">, threadId: string): void {
  introStore.close();
  introStore.showBoardFor(threadId);
  navigate.toThread(threadId);
  toast.success("Your first mate is aboard.");
}

/**
 * The app-wide overlay: the offer's toast in bb's own stack while the server offers the guide and this
 * window has not put it away, and the setup dialog. It draws nothing else.
 */
export function IntroOverlay() {
  const status = experimental_useRpcQuery({ contract: rpcContract, method: "intro.status", input: {} });
  const rpc = useRpc<typeof RpcContract>();
  const navigate = useBbNavigate();
  const { open, snoozed } = useIntroWindow();
  const offer = status.data?.offer === true;
  const show = offer && !snoozed && !open;
  // The handlers read these at click time, so the toast is not shown again for a new function.
  const latest = useRef({ rpc });
  latest.current = { rpc };

  useEffect(() => {
    if (!show) {
      toast.dismiss(INTRO_TOAST_ID);
      return;
    }
    toast(INTRO_TOAST_TITLE, {
      id: INTRO_TOAST_ID,
      duration: Infinity,
      dismissible: false,
      description: (
        <span className="flex flex-col items-start gap-1">
          <span>A two-minute setup: pick a home folder and a model, and your first mate shows you around.</span>
          <button
            type="button"
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => {
              toast.dismiss(INTRO_TOAST_ID);
              latest.current.rpc.call("intro.dismiss", {}).catch(reportError);
            }}
          >
            Don&apos;t ask again
          </button>
        </span>
      ),
      action: { label: "Start", onClick: () => introStore.open() },
      cancel: { label: "Later", onClick: () => introStore.snooze() },
    });
  }, [show]);

  // Unmounted (the plugin disabled, removed or reloaded): take the toast with it.
  useEffect(() => () => void toast.dismiss(INTRO_TOAST_ID), []);

  function started(threadId: string): void {
    showFirstMate(navigate, threadId);
  }

  if (!open) return null;
  return (
    <IntroDialog onClose={() => introStore.close()} initialHome={status.data?.homeDirectory ?? DEFAULT_HOME} onStarted={started} />
  );
}
