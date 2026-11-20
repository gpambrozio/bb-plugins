// A thread's actions and their runs, over injected ports (bb's threads, files and terminals, and
// the plugin's storage), so the tests drive it without bb.
//
// The file is read from the thread's own workspace, on the machine that holds it, every time: the
// menu lists what the branch has now, and a run starts the command the file has now. Each thread
// remembers which terminal its last run of each action went to (by action name); that is how a run
// of an action that is still running shows its terminal instead of starting another.
import { parseActionsFile } from "../shared/actions-file";
import { ACTIONS_FILE, describeLocation, type Action, type ActionsList, type ActionView, type RunOutcome, type RunStatus } from "../shared/views";
import { actionArgv, hasFinished, isWindowsPath } from "./command";

export interface Workspace {
  hostId: string;
  path: string;
}

export type WorkspaceLookup = { ok: true; workspace: Workspace } | { ok: false; message: string };

export type FileRead = { kind: "text"; text: string } | { kind: "missing" } | { kind: "error"; message: string };

export interface TerminalState {
  status: "starting" | "running" | "disconnected" | "exited";
}

/** Action name → terminal id of that action's last run in one thread. */
export type Runs = Record<string, string>;

export interface ActionsPorts {
  workspace(threadId: string): Promise<WorkspaceLookup>;
  /** Reads a file under the workspace by its path relative to the root. */
  readFile(workspace: Workspace, relativePath: string): Promise<FileRead>;
  /** null when bb no longer knows the terminal. */
  getTerminal(terminalId: string): Promise<TerminalState | null>;
  /** The terminal's latest output, decoded. */
  outputTail(terminalId: string): Promise<string>;
  createTerminal(input: { threadId: string; title: string; argv: string[] }): Promise<{ id: string }>;
  closeTerminal(terminalId: string): Promise<void>;
  loadRuns(threadId: string): Promise<Runs>;
  saveRuns(threadId: string, runs: Runs): Promise<void>;
}

/** A run that cannot start, said so the user can act on it. */
export class ActionError extends Error {}

type Loaded = { kind: "ready"; workspace: Workspace; actions: Action[] } | { kind: "other"; list: Exclude<ActionsList, { state: "ready" }> };

export function createActionsService(ports: ActionsPorts) {
  /** One run at a time per thread, so a double click cannot start an action twice. */
  const queues = new Map<string, Promise<unknown>>();
  function serialized<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    queues.set(threadId, next);
    void next.finally(() => {
      if (queues.get(threadId) === next) queues.delete(threadId);
    }).catch(() => undefined);
    return next;
  }

  async function load(threadId: string): Promise<Loaded> {
    const lookup = await ports.workspace(threadId);
    if (!lookup.ok) return { kind: "other", list: { state: "unavailable", message: lookup.message } };
    const file = await ports.readFile(lookup.workspace, ACTIONS_FILE);
    if (file.kind === "missing") return { kind: "other", list: { state: "missing" } };
    if (file.kind === "error") return { kind: "other", list: { state: "unavailable", message: file.message } };
    const parsed = parseActionsFile(file.text);
    if (!parsed.ok) return { kind: "other", list: { state: "invalid", problem: parsed.problem } };
    return { kind: "ready", workspace: lookup.workspace, actions: parsed.actions };
  }

  async function statusOf(terminalId: string | undefined): Promise<RunStatus> {
    if (terminalId === undefined) return "idle";
    const terminal = await ports.getTerminal(terminalId);
    if (terminal === null || terminal.status === "exited") return "idle";
    return hasFinished(await ports.outputTail(terminalId)) ? "finished" : "running";
  }

  async function statuses(runs: Runs): Promise<Map<string, RunStatus>> {
    const entries = await Promise.all(Object.entries(runs).map(async ([name, id]) => [name, await statusOf(id)] as const));
    return new Map(entries);
  }

  async function list(threadId: string): Promise<ActionsList> {
    const loaded = await load(threadId);
    if (loaded.kind === "other") return loaded.list;
    const known = await statuses(await ports.loadRuns(threadId));
    const actions: ActionView[] = loaded.actions.map((action) => ({ ...action, status: known.get(action.name) ?? "idle" }));
    return { state: "ready", actions };
  }

  function unavailable(list: Exclude<ActionsList, { state: "ready" }>): ActionError {
    switch (list.state) {
      case "missing":
        return new ActionError(`This workspace has no ${ACTIONS_FILE}.`);
      case "invalid":
        return new ActionError(`${list.problem.message} (${describeLocation(list.problem)})`);
      case "unavailable":
        return new ActionError(list.message);
    }
  }

  function run(threadId: string, name: string): Promise<RunOutcome> {
    return serialized(threadId, async () => {
      const loaded = await load(threadId);
      if (loaded.kind === "other") throw unavailable(loaded.list);
      const action = loaded.actions.find((candidate) => candidate.name === name);
      if (action === undefined) throw new ActionError(`${ACTIONS_FILE} has no action named "${name}" any more.`);
      if (isWindowsPath(loaded.workspace.path)) throw new ActionError("Project Actions runs actions on macOS and Linux machines only.");

      const runs = await ports.loadRuns(threadId);
      const known = await statuses(runs);
      // Forget runs whose terminals are gone, so the record stays as small as what is open.
      const kept: Runs = Object.fromEntries(Object.entries(runs).filter(([key]) => known.get(key) !== "idle"));
      const previous = runs[action.name];
      const status = known.get(action.name) ?? "idle";
      if (previous !== undefined && status === "running") {
        if (Object.keys(kept).length !== Object.keys(runs).length) await ports.saveRuns(threadId, kept);
        return { terminalId: previous, outcome: "focused" };
      }
      if (previous !== undefined && status === "finished") {
        // Its terminal only shows how it ended; the new run takes its place.
        await ports.closeTerminal(previous);
      }
      const terminal = await ports.createTerminal({ threadId, title: action.name, argv: actionArgv(loaded.workspace.path, action) });
      await ports.saveRuns(threadId, { ...kept, [action.name]: terminal.id });
      return { terminalId: terminal.id, outcome: status === "finished" ? "restarted" : "started" };
    });
  }

  return { list, run };
}
