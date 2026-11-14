/**
 * The speech hooks on the server's side: each machine's two commands, kept in
 * one kv row by bb host id, and the runs of speech a speaking window opens and
 * ends on its machine.
 *
 * The app names only the machine and its run; the commands are always the ones
 * stored here for that machine, so a window cannot have a host run anything
 * else. A machine with no command opens no run and reaches no host. The run
 * itself, and the after hook it owes, live on the machine (`host/sessions.ts`).
 */
import {
  hookFailure,
  MachineHooksSchema,
  NO_HOOKS,
  SPEECH_HOOK_LEASE_MS,
  SPEECH_HOOK_TIMEOUT_MS,
  SpeechHooksSchema,
  type HookRun,
  type MachineHooks,
  type SpeechHookKind,
  type SpeechHooks,
} from "../shared/speech-hooks";

export const SPEECH_HOOKS_KEY = "speechHooks";

/** `begin` may take the before hook's whole timeout, plus the round trip to the machine. */
export const BEGIN_TIMEOUT_MS = SPEECH_HOOK_TIMEOUT_MS + 5_000;
/** `end` may wait for a `before` still running, then run the after hook. */
export const END_TIMEOUT_MS = 2 * SPEECH_HOOK_TIMEOUT_MS + 5_000;

/** Herald's host entry on one machine; see `shared/host-contract.ts`. */
export interface HostSessionsPort {
  begin(
    hostId: string,
    input: { runId: string; before: string; after: string; leaseMs: number },
    signal?: AbortSignal,
  ): Promise<{ open: boolean; before: HookRun | null }>;
  renew(hostId: string, input: { runId: string; leaseMs: number }): Promise<{ open: boolean }>;
  end(hostId: string, input: { runId: string }): Promise<{ after: HookRun | null }>;
}

export interface SpeechHooksDeps {
  kv: { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: unknown): Promise<void> };
  host: HostSessionsPort;
  log: { info(message: string): void; warn(message: string): void; error(message: string): void };
}

export interface BeginResult {
  /** True: the run is open on the machine. False: nothing was opened. Null: unknown — the machine did not answer. */
  open: boolean | null;
  /** Why the before hook, or the call, failed; also in the plugin's log. */
  error: string | null;
}

function reasonText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SpeechHooksStore {
  /** Saves are chained: two machines saved at once must both land. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SpeechHooksDeps) {}

  /** Every machine's hooks; an unreadable row reads as none at all, and says so. */
  async all(): Promise<SpeechHooks> {
    const raw = await this.deps.kv.get<unknown>(SPEECH_HOOKS_KEY);
    if (raw === null || raw === undefined) return {};
    const parsed = SpeechHooksSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    this.deps.log.error(`Herald's speech hooks could not be read, so none run: ${parsed.error.message}`);
    return {};
  }

  /** Sets one machine's hooks; both empty forgets the machine. Answers every machine's. */
  set(hostId: string, hooks: MachineHooks): Promise<SpeechHooks> {
    const next = MachineHooksSchema.parse(hooks);
    const write = this.writes.then(async () => {
      const current = await this.all();
      const { [hostId]: _previous, ...others } = current;
      const empty = next.before.trim() === "" && next.after.trim() === "";
      const saved = empty ? others : { ...others, [hostId]: next };
      await this.deps.kv.set(SPEECH_HOOKS_KEY, saved);
      return saved;
    });
    // A failed save must not wedge the ones after it.
    this.writes = write.catch(() => {});
    return write;
  }

  /** One machine's hooks, empty when it has none. */
  async of(hostId: string): Promise<MachineHooks> {
    return (await this.all())[hostId] ?? { ...NO_HOOKS };
  }

  /**
   * Opens `runId` on `hostId`, which runs the machine's before hook when no
   * other run is open there. A machine with neither command opens nothing.
   * Never throws: a failure is logged here, with the machine.
   */
  async begin(hostId: string, runId: string, signal?: AbortSignal): Promise<BeginResult> {
    let hooks: MachineHooks;
    try {
      hooks = await this.of(hostId);
    } catch (error) {
      return { open: false, error: this.failed(`Could not read the speech hooks: ${reasonText(error)}`) };
    }
    const before = hooks.before.trim();
    const after = hooks.after.trim();
    if (before === "" && after === "") return { open: false, error: null };
    try {
      const opened = await this.deps.host.begin(hostId, { runId, before, after, leaseMs: SPEECH_HOOK_LEASE_MS }, signal);
      return { open: opened.open, error: opened.before === null ? null : this.report(hostId, "before", opened.before) };
    } catch (error) {
      // The machine may have opened it anyway; the window ends it all the same.
      return { open: null, error: this.failed(`Could not start a run of speech on ${hostId}: ${reasonText(error)}`) };
    }
  }

  /** Keeps `runId` open on `hostId`; false when the machine no longer has it open. */
  async renew(hostId: string, runId: string): Promise<boolean> {
    try {
      return (await this.deps.host.renew(hostId, { runId, leaseMs: SPEECH_HOOK_LEASE_MS })).open;
    } catch (error) {
      this.failed(`Could not keep a run of speech open on ${hostId}: ${reasonText(error)}`);
      return false;
    }
  }

  /**
   * Ends `runId` on `hostId`; the last open run there runs the after hook.
   * Reaches the machine whatever is stored now, since a run opened under the
   * old commands still owes its after hook. Safe to repeat.
   */
  async end(hostId: string, runId: string): Promise<{ error: string | null }> {
    try {
      const { after } = await this.deps.host.end(hostId, { runId });
      return { error: after === null ? null : this.report(hostId, "after", after) };
    } catch (error) {
      // The machine runs the after hook itself once the run's lease is out.
      return { error: this.failed(`Could not end a run of speech on ${hostId}; it ends by itself shortly: ${reasonText(error)}`) };
    }
  }

  /** What the machine says it ran by itself when a window stopped answering. */
  expired(hostId: string, after: HookRun | null): void {
    this.deps.log.info(`A window speaking on ${hostId} stopped answering, so its run of speech was ended there.`);
    if (after !== null) this.report(hostId, "after", after);
  }

  /** Logs one command's run; the failure text, or null when it succeeded. */
  private report(hostId: string, kind: SpeechHookKind, run: HookRun): string | null {
    const failure = hookFailure(run);
    if (failure === null) {
      this.deps.log.info(`Ran the ${kind}-speaking hook on ${hostId} (${run.durationMs} ms).`);
      return null;
    }
    return this.failed(`The ${kind}-speaking hook on ${hostId} failed: ${failure}`);
  }

  private failed(message: string): string {
    this.deps.log.warn(message);
    return message;
  }
}
