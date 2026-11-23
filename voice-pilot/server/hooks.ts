/**
 * The voice hooks on the server's side: when a session runs the hook file of the machine whose desktop app
 * holds the call (`host.ts`), and whether each machine has one, for the settings page.
 *
 * - **No command passes through here.** Each machine runs only its own `~/.config/voice-pilot/hook`; no
 *   RPC, setting or call to a machine names a command or a path, and nothing reads the file's contents. bb
 *   names its app and its command line the same caller, so anything stored in bb could be changed by an
 *   agent with `bb`; a file on the machine can only be changed by someone who can already run things there.
 * - **The server owns the moments.** It hears every one on the call's sideband (your speech, the
 *   voice's replies and their audio) and knows when the session starts and ends whatever ended it, a window
 *   that went away included. The app names only its machine.
 * - **Pairs.** Listening, speaking (the voice) and talking (the user) each run "started" then "stopped".
 *   The voice's replies back to back, a tool call between them included, are one pair: "speaking-stopped"
 *   runs once its audio has stopped, no reply is under way and `SPEAKING_SETTLE_MS` has passed quietly. A
 *   session that ends closes its open pairs, then runs "listening-stopped" with the reason.
 * - **Never in the call's way.** Nothing in the call awaits a hook. Runs queue in three lanes (one per pair,
 *   so a slow speaking hook does not hold your back); each run is stopped on its machine after
 *   `HOOK_TIMEOUT_MS`, and this side gives up waiting after `HOOK_CALL_TIMEOUT_MS`. A "stopped" runs after
 *   its "started" has finished or been stopped, never before, and the speaking and talking lanes start once
 *   "listening-started" has. A session that ends reserves its "listening-stopped" in the listening lane at
 *   once, so the next session's "listening-started" (and with it everything else of the next session) runs
 *   only after the old session's closing hooks.
 * - **Only once the call is made.** "listening-started" runs when OpenAI has accepted the call, not when Talk
 *   is asked for, so a caller with no real WebRTC offer and no ChatGPT sign-in runs no hook. Live speech
 *   cannot be held back, so "speaking-started" runs at the first sign of a spoken reply, before its audio,
 *   and the voice speaks whether or not it has finished.
 * - **The debug log** gets each run: the moment, the machine, the exit status and the duration, and the
 *   `BB_SERVER_URL` the hook got (bb's relay on a Connect machine, `host/relay.ts`) or why it got none. Never
 *   the output, which is not even read.
 */
import { hookFailed, hookOutcome, relayLine, HOOK_FILE_SHOWN, HOOK_TIMEOUT_MS, type HookEvent, type HookFileStatus, type HookRun } from "../shared/hooks";
import type { DebugLog } from "./debug-log";
import { errorText, type Clock, type Log, type RealtimeEvent } from "./ports";

/** How long the server waits for a machine's answer: the hook's own limit, plus the round trip. */
export const HOOK_CALL_TIMEOUT_MS = HOOK_TIMEOUT_MS + 5_000;
/** How long the voice stays quiet, with no reply under way, before its speaking pair ends. */
export const SPEAKING_SETTLE_MS = 1_000;

/** How long a machine may take to say whether it has a hook file. */
export const HOOK_STATUS_TIMEOUT_MS = 5_000;

/** The host entry on one machine; see `shared/host-contract.ts`. Neither call names a command or a path. */
export interface HostHookPort {
  status(hostId: string): Promise<HookFileStatus>;
  /** Null when the machine has no hook file (any more). */
  run(hostId: string, input: { event: HookEvent; reason: string | null }): Promise<HookRun | null>;
}

/** One machine's hook file as the settings page shows it: there, runnable, or not known (unreachable). */
export interface MachineHookStatus {
  hostId: string;
  name: string;
  status: HookFileStatus | null;
}

/** Whether each of `hosts` has a hook file; a machine that does not answer in time is `null`. Never rejects. */
export async function machineHookStatuses(
  hosts: ReadonlyArray<{ id: string; name: string }>,
  host: Pick<HostHookPort, "status">,
  clock: Clock,
): Promise<MachineHookStatus[]> {
  return Promise.all(
    hosts.map(async ({ id, name }) => ({
      hostId: id,
      name,
      status: await withTimeout(host.status(id), HOOK_STATUS_TIMEOUT_MS, clock).catch(() => null),
    })),
  );
}

type Lane = "listening" | "speaking" | "talking";

/**
 * Where a session's hooks run: a machine, or nowhere and why (bb's mobile app, a browser tab, a desktop app
 * whose machine is not one of bb's).
 */
export type HookTarget = { hostId: string; name: string } | { hostId: null; why: string };

export interface HookRunnerDeps {
  host: HostHookPort;
  clock: Clock;
  log: Log;
}

/** The lanes every session's hooks queue in, so one session's last hooks run before the next one's first. */
export class HookRunner {
  private readonly lanes = new Map<Lane, Promise<void>>();

  constructor(readonly deps: HookRunnerDeps) {}

  /** Runs `job` after everything queued in `lane`; never rejects. */
  enqueue(lane: Lane, job: () => Promise<void>): Promise<void> {
    const next = (this.lanes.get(lane) ?? Promise.resolve()).then(job).catch(() => {});
    this.lanes.set(lane, next);
    return next;
  }

  /** Settles once everything queued in `lanes` so far has run. */
  async drained(lanes: readonly Lane[] = ["listening", "speaking", "talking"]): Promise<void> {
    await Promise.all(lanes.map((lane) => this.lanes.get(lane)));
  }

  /** What is queued in `lane` so far, taken now: later jobs are not waited for. */
  tail(lane: Lane): Promise<void> {
    return this.lanes.get(lane) ?? Promise.resolve();
  }

  session(target: HookTarget, debug: DebugLog): SessionHooks {
    return new SessionHooks(this, target, debug);
  }
}

/** One session's hooks: which pairs are open, and when to run each moment. */
export class SessionHooks {
  private listening = false;
  private speaking = false;
  private talking = false;
  /** The voice's audio is playing on the device. */
  private audio = false;
  /** A reply is under way on the call. */
  private busy = false;
  private settle: unknown = null;
  private ended = false;
  /** "listening-started" has run (or was skipped): the other lanes wait for it. */
  private opened: Promise<void> = Promise.resolve();
  /** Whether the machine had a runnable hook file when listening started; none runs for the session otherwise. */
  private runnable: Promise<boolean> = Promise.resolve(false);

  constructor(
    private readonly runner: HookRunner,
    private readonly target: HookTarget,
    private readonly debug: DebugLog,
  ) {}

  /** Says in the debug log where this session's hooks run, then runs "listening-started". Once the call is made. */
  start(): void {
    if (this.ended) return;
    if (this.target.hostId === null) {
      this.debug.add("hook", `No hooks this session: ${this.target.why}`);
      return;
    }
    const { hostId, name } = this.target;
    const { host, clock } = this.runner.deps;
    this.runnable = withTimeout(host.status(hostId), HOOK_STATUS_TIMEOUT_MS, clock).then(
      (status) => {
        if (!status.present) this.debug.add("hook", `No hook this session: ${name}, this window's machine, has no ${HOOK_FILE_SHOWN}`);
        else if (!status.executable) this.debug.add("hook", `No hook this session: ${HOOK_FILE_SHOWN} on ${name} is not executable (chmod +x)`);
        else this.debug.add("hook", `The hook runs on ${name}, this window's machine: ${HOOK_FILE_SHOWN}`);
        return status.present && status.executable;
      },
      (error: unknown) => {
        this.debug.add("hook", `No hook this session: ${name} did not say whether it has a hook file`, errorText(error));
        return false;
      },
    );
    this.listening = true;
    this.opened = this.run("listening", "listening-started");
  }

  /**
   * A sideband event of the live call, after the session has handled it; `busy` says whether a reply is still
   * under way on the call.
   */
  event(event: RealtimeEvent, busy: boolean): void {
    if (this.ended || !this.listening) return;
    this.busy = busy;
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        if (!this.talking) {
          this.talking = true;
          void this.run("talking", "talking-started");
        }
        break;
      case "input_audio_buffer.speech_stopped":
        if (this.talking) {
          this.talking = false;
          void this.run("talking", "talking-stopped");
        }
        break;
      case "response.output_item.added": {
        // A message item is a spoken reply (the call's output is audio): its first sign, before any sound.
        const item = event.item as { type?: unknown } | undefined;
        if (item?.type === "message") this.voiceComing();
        break;
      }
      case "output_audio_buffer.started":
        this.audio = true;
        this.voiceComing();
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.audio = false;
        break;
    }
    this.check();
  }

  /**
   * Closes the open pairs, then runs "listening-stopped" with `reason`. Never rejects. Everything is queued
   * before this returns its promise, the barrier included: "listening-stopped" holds the listening lane
   * until this session's speaking and talking hooks are done, so a session started next waits for them.
   */
  end(reason: string): Promise<void> {
    if (this.ended) return Promise.resolve();
    this.ended = true;
    this.cancelSettle();
    if (this.speaking) {
      this.speaking = false;
      void this.run("speaking", "speaking-stopped");
    }
    if (this.talking) {
      this.talking = false;
      void this.run("talking", "talking-stopped");
    }
    if (!this.listening) return Promise.resolve();
    this.listening = false;
    const closing = [this.runner.tail("speaking"), this.runner.tail("talking")];
    return this.runner.enqueue("listening", async () => {
      await Promise.all(closing);
      await this.execute("listening", "listening-stopped", reason);
    });
  }

  private voiceComing(): void {
    this.cancelSettle();
    if (this.speaking) return;
    this.speaking = true;
    void this.run("speaking", "speaking-started");
  }

  /** Starts the quiet spell that ends a speaking pair, or cancels it when the voice is not quiet. */
  private check(): void {
    if (!this.speaking || this.audio || this.busy) {
      this.cancelSettle();
      return;
    }
    if (this.settle !== null) return;
    const clock = this.runner.deps.clock;
    this.settle = clock.setTimeout(() => {
      this.settle = null;
      if (this.ended || !this.speaking || this.audio || this.busy) return;
      this.speaking = false;
      void this.run("speaking", "speaking-stopped");
    }, SPEAKING_SETTLE_MS);
  }

  private cancelSettle(): void {
    if (this.settle === null) return;
    this.runner.deps.clock.clearTimeout(this.settle);
    this.settle = null;
  }

  /** Queues one run of the machine's hook file for `event` in `lane`. */
  private run(lane: Lane, event: HookEvent, reason: string | null = null): Promise<void> {
    if (this.target.hostId === null) return Promise.resolve();
    return this.runner.enqueue(lane, () => this.execute(lane, event, reason));
  }

  /** Runs the machine's hook file for `event` once its lane's turn has come, if it had a runnable one. */
  private async execute(lane: Lane, event: HookEvent, reason: string | null): Promise<void> {
    const target = this.target;
    if (target.hostId === null) return;
    const { hostId, name } = target;
    if (lane !== "listening") await this.opened;
    if (!(await this.runnable)) return;
    const { host, clock, log } = this.runner.deps;
    const reasonNote = reason === null ? undefined : `VOICE_PILOT_REASON: ${reason}`;
    try {
      const run = await withTimeout(host.run(hostId, { event, reason }), HOOK_CALL_TIMEOUT_MS, clock);
      // The file went during the session: nothing ran, and there is nothing to say for each moment.
      if (run === null) return;
      const note = [reasonNote, relayLine(run)].filter((line) => line !== undefined && line !== null).join("\n");
      this.debug.add("hook", `Hook ${event} on ${name}: ${hookOutcome(run)}`, note);
      if (hookFailed(run)) log.warn(`The voice hook for ${event} on ${name} failed: ${hookOutcome(run)}.`);
    } catch (error) {
      this.debug.add("hook", `Hook ${event} on ${name} did not run: ${errorText(error)}`, reasonNote);
      log.warn(`The voice hook for ${event} on ${name} did not run: ${errorText(error)}`);
    }
  }
}

/** `work`, or a rejection once `ms` have passed without an answer. */
function withTimeout<T>(work: Promise<T>, ms: number, clock: Clock): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = clock.setTimeout(() => reject(new Error(`the machine did not answer within ${Math.round(ms / 1000)} s`)), ms);
    work.then(
      (value) => {
        clock.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clock.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Which bb client tapped Talk, as the app tells them apart (`app/platform.ts`). */
export type VoiceClient = "desktop" | "mobile" | "browser";

/**
 * Where a session's hooks run, from what the app said: only bb's desktop app runs them, on its own machine,
 * and only on a machine bb knows (`hosts`, the active ones), so a window cannot name another.
 */
export function hookTarget(client: VoiceClient | undefined, hostId: string | null | undefined, hosts: ReadonlyArray<{ id: string; name: string }>): HookTarget {
  if (client === "mobile") return { hostId: null, why: "bb's mobile app runs no hooks" };
  if (client !== "desktop") return { hostId: null, why: "a browser tab runs no hooks; bb's desktop app does" };
  if (hostId === null || hostId === undefined) return { hostId: null, why: "this window's machine is not one of bb's machines for this server" };
  const host = hosts.find((candidate) => candidate.id === hostId);
  if (host === undefined) return { hostId: null, why: `this window's machine (${hostId}) is not one of bb's active machines` };
  return { hostId, name: host.name };
}
