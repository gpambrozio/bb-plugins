// project-actions — the server entry.
//
// Wires the actions service (server/service.ts) to bb: the thread's environment says which machine
// and folder hold its workspace, bb's file API reads `.bb/actions.json` on that machine, and bb's
// terminal API starts each action in a terminal of the thread. The plugin runs nothing itself and
// needs no host entry: bb's host daemons run the terminals. See AGENTS.md.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { LIMITS } from "./shared/actions-file";
import { rpcContract } from "./shared/contract";
import { TAIL_BYTES } from "./server/command";
import { ActionError, createActionsService, type FileRead, type Runs, type WorkspaceLookup } from "./server/service";

export type { RpcContract } from "./shared/contract";

/** A new terminal's size until bb's terminal panel fits it to the window. */
const TERMINAL_SIZE = { cols: 120, rows: 32 } as const;

const RunsSchema = z.record(z.string(), z.string());

function runsKey(threadId: string): string {
  return `runs:${threadId}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A file under the workspace by its path relative to the root. */
function filePath(workspace: { path: string }, relativePath: string): string {
  return `${workspace.path.replace(/\/+$/, "")}/${relativePath}`;
}

function status(error: unknown): unknown {
  return (error as { status?: unknown } | null)?.status;
}

/**
 * Whether a failed `files.read` says the file is not there. bb's file calls are not documented to
 * fail in a typed way, so this takes a 404, a `not_found` or ENOENT code, or a message that says so.
 */
function isMissingFile(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (status(error) === 404 || code === "not_found" || code === "ENOENT") return true;
  return /not found|no such file|enoent|does not exist/i.test(message(error));
}

export default async function plugin(bb: BbPluginApi) {
  const service = createActionsService({
    async workspace(threadId): Promise<WorkspaceLookup> {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.environmentId === null) return { ok: false, message: "This thread has no workspace yet." };
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      if (environment.status === "destroyed" || environment.path === null) return { ok: false, message: "This thread's workspace is gone." };
      if (environment.status !== "ready") return { ok: false, message: "This thread's workspace is still being set up." };
      const host = await bb.sdk.hosts.get({ hostId: environment.hostId });
      if (host.status !== "connected") return { ok: false, message: `${host.name} is offline, so its workspace cannot be read.` };
      return { ok: true, workspace: { hostId: environment.hostId, path: environment.path, branch: environment.branchName } };
    },
    async readFile(workspace, relativePath): Promise<FileRead> {
      let file;
      try {
        file = await bb.sdk.files.read({ hostId: workspace.hostId, rootPath: workspace.path, path: filePath(workspace, relativePath) });
      } catch (error) {
        if (isMissingFile(error)) return { kind: "missing" };
        bb.log.warn(`reading ${relativePath} failed: ${message(error)}`);
        return { kind: "error", message: `${relativePath} could not be read: ${message(error)}` };
      }
      if (file.sizeBytes > LIMITS.fileBytes) return { kind: "error", message: `${relativePath} is larger than ${LIMITS.fileBytes / 1024} KB.` };
      const text = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
      return { kind: "text", text, sha256: file.sha256 };
    },
    async writeFile(workspace, relativePath, content, expectedSha256) {
      const written = await bb.sdk.files.write({
        hostId: workspace.hostId,
        rootPath: workspace.path,
        path: filePath(workspace, relativePath),
        content,
        createParents: true,
        expectedSha256,
      });
      return written.outcome === "written" ? { outcome: "written", sha256: written.sha256 } : { outcome: "conflict" };
    },
    async getTerminal(terminalId) {
      try {
        return await bb.sdk.terminals.get({ terminalId });
      } catch (error) {
        if (status(error) === 404) return null;
        throw error;
      }
    },
    async outputTail(terminalId) {
      const output = await bb.sdk.terminals.output({ terminalId, tailBytes: TAIL_BYTES });
      return Buffer.concat(output.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64"))).toString("utf8");
    },
    createTerminal: ({ threadId, title, argv }) =>
      bb.sdk.terminals.create({ scope: { kind: "thread", threadId }, title, ...TERMINAL_SIZE, start: { mode: "argv", argv } }),
    async closeTerminal(terminalId) {
      await bb.sdk.terminals.close({ terminalId, mode: "force" });
    },
    async loadRuns(threadId): Promise<Runs> {
      const parsed = RunsSchema.safeParse((await bb.storage.kv.get<unknown>(runsKey(threadId))) ?? {});
      if (!parsed.success) {
        bb.log.warn(`ignoring an unreadable run record for ${threadId}`);
        return {};
      }
      return parsed.data;
    },
    async saveRuns(threadId, runs) {
      if (Object.keys(runs).length === 0) await bb.storage.kv.delete(runsKey(threadId));
      else await bb.storage.kv.set(runsKey(threadId), runs);
    },
  });

  /** An ActionError is the user's to read; anything else is logged and said plainly. */
  async function answer<T>(what: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ActionError) throw error;
      bb.log.warn(`${what} failed: ${message(error)}`);
      throw new Error(`${what} failed: ${message(error)}`);
    }
  }

  bb.rpc.register(rpcContract, {
    list: ({ threadId }) => service.list(threadId),
    read: ({ threadId }) => service.read(threadId),
    save: ({ threadId, text, expectedSha256 }) => answer("Saving the actions file", () => service.save(threadId, text, expectedSha256)),
    run: ({ threadId, name }) => answer(`Starting "${name}"`, () => service.run(threadId, name)),
  });

  // A thread's terminals end with it; so does the record of its runs.
  const forget = ({ thread }: { thread: { id: string } }) => bb.storage.kv.delete(runsKey(thread.id));
  bb.events.on("thread.archived", forget);
  bb.events.on("thread.deleted", forget);
}
