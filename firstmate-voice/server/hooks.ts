/**
 * The voice hooks on the server's side: each machine's command, kept in one kv row by bb host id, and when a
 * session runs it on the machine whose desktop app holds the call (`host.ts`).
 *
 * - **The server owns the moments.** It hears every one on the call's sideband (the captain's speech, the
 *   voice's replies and their audio) and knows when the session starts and ends whatever ended it, a window
 *   that went away included. The app names only its machine; the command is always the one stored here for
 *   that machine.
 * - **Pairs.** Listening, speaking (the voice) and talking (the captain) each run "started" then "stopped".
 *   The voice's replies back to back, a tool call between them included, are one pair: "speaking-stopped"
 *   runs once its audio has stopped, no reply is under way and `SPEAKING_SETTLE_MS` has passed quietly. A
 *   session that ends closes its open pairs, then runs "listening-stopped" with the reason.
 * - **Never in the call's way.** Nothing in the call awaits a hook. Runs queue in three lanes (one per pair,
 *   so a slow speaking hook does not hold the captain's back); each run is stopped on its machine after
 *   `HOOK_TIMEOUT_MS`, and this side gives up waiting after `HOOK_CALL_TIMEOUT_MS`. A "stopped" runs after
 *   its "started" has finished or been stopped, never before, and the speaking and talking lanes start once
 *   "listening-started" has. Live speech cannot be held back, so "speaking-started" runs at the first sign
 *   of a spoken reply, before its audio, and the voice speaks whether or not it has finished.
 * - **The debug log** gets each run: the moment, the machine, the exit status and the duration. Never the
 *   output, which is not even read.
 */
import { hookCommand, hookFailed, hookOutcome, HOOK_TIMEOUT_MS, HookCommandSchema, VoiceHooksSchema, type HookEvent, type HookRun, type VoiceHooks } from "../shared/hooks";
import type { DebugLog } from "./debug-log";
import { errorText, type Clock, type Log, type RealtimeEvent } from "./ports";

export const HOOKS_KEY = "hooks";
/** How long the server waits for a machine's answer: the hook's own limit, plus the round trip. */
export const HOOK_CALL_TIMEOUT_MS = HOOK_TIMEOUT_MS + 5_000;
/** How long the voice stays quiet, with no reply under way, before its speaking pair ends. */
export const SPEAKING_SETTLE_MS = 1_000;

/** The host entry on one machine; see `shared/host-contract.ts`. */
export interface HostHookPort {
  run(hostId: string, input: { command: string; event: HookEvent; reason: string | null }): Promise<HookRun>;
}

export interface KvPort {
  get<T>(key: string): Promise<T | null | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export class HookStore {
  /** Saves are chained: two machines saved at once must both land. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly kv: KvPort,
    private readonly log: Log,
  ) {}

  /** Every machine's command; an unreadable row reads as none at all, and says so. */
  async all(): Promise<VoiceHooks> {
    const raw = await this.kv.get<unknown>(HOOKS_KEY);
    if (raw === null || raw === undefined) return {};
    const parsed = VoiceHooksSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    this.log.error(`The voice hooks could not be read, so none run: ${parsed.error.message}`);
    return {};
  }

  /** Sets one machine's command; an empty one forgets the machine. Answers every machine's. */
  set(hostId: string, command: string): Promise<VoiceHooks> {
    const next = HookCommandSchema.parse(command);
    const write = this.writes.then(async () => {
      const { [hostId]: _previous, ...others } = await this.all();
      const saved = next.trim() === "" ? others : { ...others, [hostId]: next };
      await this.kv.set(HOOKS_KEY, saved);
      return saved;
    });
    // A failed save must not wedge the ones after it.
    this.writes = write.catch(() => {});
    return write;
  }

  /** The machine's command, or null when it has none. */
  async command(hostId: string): Promise<string | null> {
    return hookCommand(await this.all(), hostId);
  }
}

type Lane = "listening" | "speaking" | "talking";

/**
 * Where a session's hooks run: a machine, or nowhere and why (bb's mobile app, a browser tab, a desktop app
 * whose machine is not one of bb's).
 */
export type HookTarget = { hostId: string; name: string } | { hostId: null; why: string };

export interface HookRunnerDeps {
  store: Pick<HookStore, "command">;
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

  constructor(
    private readonly runner: HookRunner,
    private readonly target: HookTarget,
    private readonly debug: DebugLog,
  ) {}

  /** Says in the debug log where this session's hooks run, then runs "listening-started". */
  start(): void {
    if (this.target.hostId === null) {
      this.debug.add("hook", `No hooks this session: ${this.target.why}`);
      return;
    }
    const { hostId, name } = this.target;
    void this.runner.deps.store.command(hostId).then(
      (command) => this.debug.add("hook", command === null ? `No hook is set for ${name}, this window's machine` : `Hooks run on ${name}, this window's machine`),
      () => undefined,
    );
    this.listening = true;
    this.opened = this.run("listening", "listening-started");
  }

  /**
   * A sideband event of the live call, after the session has handled it; `busy` says whether a reply is still
   * under way on the call.
   */
  event(event: RealtimeEvent, busy: boolean): void {
    if (this.ended || this.target.hostId === null) return;
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

  /** Closes the open pairs, then runs "listening-stopped" with `reason`. Never rejects. */
  async end(reason: string): Promise<void> {
    if (this.ended) return;
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
    if (!this.listening) return;
    this.listening = false;
    await this.runner.drained(["speaking", "talking"]);
    await this.run("listening", "listening-stopped", reason);
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

  /** Queues one run of the machine's command for `event`; the command is read when its turn comes. */
  private run(lane: Lane, event: HookEvent, reason: string | null = null): Promise<void> {
    const target = this.target;
    if (target.hostId === null) return Promise.resolve();
    const { hostId, name } = target;
    const opened = this.opened;
    return this.runner.enqueue(lane, async () => {
      if (lane !== "listening") await opened;
      const { store, host, clock, log } = this.runner.deps;
      let command: string | null;
      try {
        command = await store.command(hostId);
      } catch (error) {
        this.debug.add("hook", `Hook ${event} not run: the hooks could not be read`, errorText(error));
        return;
      }
      if (command === null) return;
      const reasonNote = reason === null ? undefined : `FIRSTMATE_VOICE_REASON: ${reason}`;
      try {
        const run = await withTimeout(host.run(hostId, { command, event, reason }), HOOK_CALL_TIMEOUT_MS, clock);
        this.debug.add("hook", `Hook ${event} on ${name}: ${hookOutcome(run)}`, reasonNote);
        if (hookFailed(run)) log.warn(`The voice hook for ${event} on ${name} failed: ${hookOutcome(run)}.`);
      } catch (error) {
        this.debug.add("hook", `Hook ${event} on ${name} did not run: ${errorText(error)}`, reasonNote);
        log.warn(`The voice hook for ${event} on ${name} did not run: ${errorText(error)}`);
      }
    });
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
