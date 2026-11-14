/**
 * The speech hooks on the server's side: each machine's two commands, kept in
 * one kv row by bb host id, and the run a speaking window asks for.
 *
 * The app names only the machine and which hook; the command is always the
 * one stored here for that machine, so a window cannot have a host run
 * anything else. An empty command runs nothing and reaches no host.
 */
import {
  hookCommand,
  hookFailure,
  MachineHooksSchema,
  NO_HOOKS,
  SPEECH_HOOK_TIMEOUT_MS,
  SpeechHooksSchema,
  type HookRun,
  type MachineHooks,
  type SpeechHookKind,
  type SpeechHooks,
} from "../shared/speech-hooks";

export const SPEECH_HOOKS_KEY = "speechHooks";

/** The host call may take the hook's whole timeout, plus the round trip to the machine. */
export const HOST_CALL_TIMEOUT_MS = SPEECH_HOOK_TIMEOUT_MS + 5_000;

export interface SpeechHooksDeps {
  kv: { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: unknown): Promise<void> };
  /** Runs `command` on the machine `hostId` through Herald's host entry. */
  runOnHost(hostId: string, kind: SpeechHookKind, command: string, signal?: AbortSignal): Promise<HookRun>;
  log: { info(message: string): void; warn(message: string): void; error(message: string): void };
}

export interface HookResult {
  /** False when the machine has no command for this hook, so nothing ran. */
  ran: boolean;
  /** Why it failed, when it ran and failed; also in the plugin's log. */
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
   * Runs `kind` on `hostId` when that machine has a command for it. Never
   * throws: a failure is logged here, with the machine, and returned for the
   * window to report too.
   */
  async run(hostId: string, kind: SpeechHookKind, signal?: AbortSignal): Promise<HookResult> {
    let command: string | null;
    try {
      command = hookCommand(await this.all(), hostId, kind);
    } catch (error) {
      const message = `Could not read the speech hooks: ${reasonText(error)}`;
      this.deps.log.error(message);
      return { ran: false, error: message };
    }
    if (command === null) return { ran: false, error: null };
    let failure: string | null;
    try {
      const run = await this.deps.runOnHost(hostId, kind, command, signal);
      failure = hookFailure(run);
      if (failure === null) this.deps.log.info(`Ran the ${kind}-speaking hook on ${hostId} (${run.durationMs} ms).`);
    } catch (error) {
      failure = `the machine could not run it: ${reasonText(error)}`;
    }
    if (failure === null) return { ran: true, error: null };
    const message = `The ${kind}-speaking hook on ${hostId} failed: ${failure}`;
    this.deps.log.warn(message);
    return { ran: true, error: message };
  }
}
