/**
 * What the voice's tools do in bb, as a narrow interface (`BbPort`), and its implementation over `bb.sdk`
 * (`sdkBb`). The tools (`tools.ts`) are tested against an in-memory fake (`testing/fake-bb.ts`).
 *
 * There is no merge, archive, delete, rename or settings call here: nothing in this plugin can do one by
 * voice. Sends queue behind a running turn (`queue-if-active`) rather than steer it, so a spoken message
 * never cuts into an agent's work.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { gatherBriefing, gatherThread, statusWord } from "./briefing/gather";
import type { ThreadRow } from "./briefing/ports";
import { renderBriefing, renderThread } from "./briefing/render";
import { chunks, sdkPorts, toRow, type ListRow } from "./briefing/sdk-ports";
import { cleanTitle } from "./briefing/text";
import { greetingList, type GreetingList } from "./greeting";
import type { Answers, Decision } from "./questions";

type Sdk = BbPluginApi["sdk"];

/** A thread as the voice names it. */
export interface ThreadInfo {
  id: string;
  title: string;
  projectId: string;
  project: string | null;
  /** In plain words: working, idle, failed, … */
  status: string;
  waitsOnYou: boolean;
  isRoot: boolean;
  updatedAt: number;
}

export interface BbPort {
  /** The whole briefing as text that fits one tool result (`briefing/render.ts`). */
  briefing(): Promise<string>;
  /** One thread in depth, or null when there is no such thread. */
  threadDetail(threadId: string): Promise<string | null>;
  /** The full text of the thread's latest reply (its latest turn's, else its last message), or null for none. */
  reply(threadId: string): Promise<string | null>;
  /** The running threads, for the greeting. */
  greeting(): Promise<GreetingList>;
  thread(threadId: string): Promise<ThreadInfo | null>;
  /** Threads whose title or messages match, best first. */
  search(query: string): Promise<ThreadInfo[]>;
  projects(): Promise<Array<{ id: string; name: string }>>;
  /** Every thread, root or not, with a question or an approval waiting on you. */
  waiting(): Promise<ThreadInfo[]>;
  /** The thread's pending interactions, as bb gives them (`questions.ts` reads them). */
  interactions(threadId: string): Promise<unknown[]>;
  answer(threadId: string, interactionId: string, via: "provider" | "plugin", answers: Answers): Promise<void>;
  decide(threadId: string, interactionId: string, decision: Decision): Promise<void>;
  /** `message` is what the thread shows; `note` goes beside it for the agent only. */
  send(threadId: string, message: string, note: string): Promise<"sent" | "queued">;
  /** A new thread in the project, in the project's default environment, as bb's New thread screen starts one. */
  start(projectId: string, prompt: string, note: string): Promise<{ id: string }>;
  stop(threadId: string): Promise<void>;
}

/** How long one call to bb may take before the tool says so. */
export const BB_CALL_TIMEOUT_MS = 10_000;
const PAGE = 200;
const MAX_THREADS = 1_000;

function timeout(): AbortSignal {
  return AbortSignal.timeout(BB_CALL_TIMEOUT_MS);
}

export function threadInfo(row: ThreadRow, projects: ReadonlyMap<string, string>): ThreadInfo {
  return {
    id: row.id,
    title: cleanTitle(row.title ?? row.titleFallback ?? "Untitled"),
    projectId: row.projectId,
    project: projects.get(row.projectId) ?? null,
    status: statusWord(row.status),
    waitsOnYou: row.hasPendingInteraction,
    isRoot: row.parentThreadId === null,
    updatedAt: row.updatedAt,
  };
}

export function sdkBb(sdk: Sdk): BbPort {
  const briefingPorts = () => sdkPorts(sdk, undefined);
  const projectNames = async () => new Map((await briefingPorts().projects()).map((project) => [project.id, project.name]));
  const rows = async (ids: readonly string[]): Promise<ThreadRow[]> => {
    const out: ThreadRow[] = [];
    for (const chunk of chunks(ids, PAGE)) out.push(...(await sdk.threads.list({ threadIds: chunk, limit: PAGE, signal: timeout() })).map(toRow));
    return out;
  };

  return {
    async briefing() {
      return renderBriefing(await gatherBriefing(briefingPorts()));
    },
    async threadDetail(threadId) {
      const detail = await gatherThread(briefingPorts(), threadId);
      return detail === null ? null : renderThread(detail);
    },
    async reply(threadId) {
      return briefingPorts().latestReply(threadId);
    },
    async greeting() {
      const ports = briefingPorts();
      const [{ threads }, projects] = await Promise.all([ports.rootThreads(), ports.projects()]);
      return greetingList(threads, projects);
    },
    async thread(threadId) {
      const [row] = await rows([threadId]);
      return row === undefined || row.archivedAt !== null ? null : threadInfo(row, await projectNames());
    },
    async search(query) {
      const result = await sdk.threads.search({ query, limitPerGroup: "8", signal: timeout() });
      const ids = [...new Set(result.active.results.map((hit) => hit.thread.id))];
      const found = new Map((await rows(ids)).map((row) => [row.id, row]));
      const names = await projectNames();
      return ids.map((id) => found.get(id)).filter((row): row is ThreadRow => row !== undefined && row.archivedAt === null).map((row) => threadInfo(row, names));
    },
    async projects() {
      return (await briefingPorts().projects()).map(({ id, name }) => ({ id, name }));
    },
    async waiting() {
      const found: ThreadRow[] = [];
      for (let offset = 0; offset < MAX_THREADS; offset += PAGE) {
        const page = (await sdk.threads.list({ archived: false, limit: PAGE, offset, signal: timeout() })) as unknown as ListRow[];
        found.push(...page.filter((row) => row.hasPendingInteraction).map(toRow));
        if (page.length < PAGE) break;
      }
      const names = await projectNames();
      return found.sort((a, b) => b.updatedAt - a.updatedAt).map((row) => threadInfo(row, names));
    },
    async interactions(threadId) {
      return [...(await sdk.threads.interactions.list({ threadId, signal: timeout() }))];
    },
    async answer(threadId, interactionId, via, answers) {
      if (via === "provider") await sdk.threads.interactions.resolve({ threadId, interactionId, resolution: { kind: "user_answer", answers } });
      else await sdk.threads.interactions.respond({ threadId, interactionId, value: { answers } });
    },
    async decide(threadId, interactionId, decision) {
      const resolution = decision === "deny" ? { decision } : { decision, grantedPermissions: null };
      await sdk.threads.interactions.resolve({ threadId, interactionId, resolution });
    },
    async send(threadId, message, note) {
      const result = await sdk.threads.send({
        threadId,
        mode: "queue-if-active",
        input: [
          { type: "text", text: message, mentions: [] },
          { type: "text", text: note, mentions: [], visibility: "agent-only" },
        ],
      });
      return result.delivery === "queued" ? "queued" : "sent";
    },
    async start(projectId, prompt, note) {
      // The project's own default, as bb's New thread screen starts one: its provider, model and workspace.
      const row = await sdk.threads.spawn({
        projectId,
        input: [
          { type: "text", text: prompt, mentions: [] },
          { type: "text", text: note, mentions: [], visibility: "agent-only" },
        ],
        environment: { type: "project-default" },
      });
      return { id: row.id };
    },
    async stop(threadId) {
      await sdk.threads.stop({ threadId, signal: timeout() });
    },
  };
}
