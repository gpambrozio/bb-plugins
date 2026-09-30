// GitHub Board — the server entry.
//
// Runs `gh` on the bb server's machine, with the user's own `gh` login, and
// matches cards to bb projects. What each handler does lives in
// server/service.ts; this file wires it to bb: settings, storage, realtime,
// projects and thread creation. See AGENTS.md.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { PromptSettings } from "./shared/board";
import { rpcContract } from "./shared/contract";
import {
  DISPLAY_PREFS_CHANGED,
  ITEM_PATCHED,
  PROMPTS_CHANGED,
  type DisplayPrefs,
  type ItemPatch,
  type LaunchDefaults,
} from "./shared/schemas";
import { workspaceTitle } from "./shared/launch";
import { remoteIdsOf } from "./shared/remotes";
import { DEFAULT_PROMPTS, normalizePrompts } from "./shared/settings";
import { describeGhFailure, findGh, ghGraphql, ghRunner, ghToken, type GhRunner } from "./server/gh";
import type { GitHubApi } from "./server/github";
import { buildProjectIndex, type ProjectIndex, type ProjectRecord } from "./server/projects";
import { CACHE_TTL_MS, createBoardService } from "./server/service";

export type { RpcContract } from "./shared/contract";

const execFileAsync = promisify(execFile);

const GH_HINT =
  "Install the GitHub CLI (`brew install gh`) and run `gh auth login` on the machine running bb, then `bb plugin reload github-board`.";

const DISPLAY_KEY = "display";
const PROMPTS_KEY = "prompts";
const LAUNCH_KEY = "launch";

const DEFAULT_DISPLAY: DisplayPrefs = { hiddenRepositories: [], detailWidthFraction: null };

type SpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];

/** Every remote of the checkout at `path`; nothing for a directory that is not one, or is gone. */
async function localRemotes(path: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", path, "remote", "-v"], { timeout: 10_000 });
    return remoteIdsOf(stdout);
  } catch {
    return [];
  }
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    login: {
      type: "string",
      label: "GitHub login",
      description:
        "Whose work the board shows. Leave blank for the account the GitHub CLI is signed in as.",
      default: "",
    },
  });

  // `gh` is looked for once per load. A missing or signed-out `gh` marks the
  // plugin as needing configuration rather than failing the load; the board
  // then shows the same message on every column.
  let gh: GhRunner | null = null;
  let ghProblem: string | null = null;
  const ghPath = await findGh();
  if (ghPath === null) {
    ghProblem = `GitHub CLI (gh) was not found. ${GH_HINT}`;
  } else {
    gh = ghRunner(ghPath);
    try {
      await gh(["auth", "status", "--hostname", "github.com"]);
    } catch (error) {
      const message = describeGhFailure(error);
      if (/not authenticated|not logged in|gh auth login/i.test(message)) {
        ghProblem = `GitHub CLI is not signed in. ${GH_HINT}`;
      } else {
        // Probably transient (the network); every call reports its own failure.
        bb.log.warn(`gh auth status failed: ${message}`);
      }
    }
  }
  if (ghProblem !== null) bb.status.needsConfiguration(ghProblem);

  function requireGh(): GhRunner {
    if (gh === null || ghProblem !== null) throw new Error(ghProblem ?? `GitHub CLI is unavailable. ${GH_HINT}`);
    return gh;
  }

  const api: GitHubApi = {
    graphql: (query, variables) => ghGraphql(requireGh(), query, variables),
    warn: (message) => bb.log.warn(message),
  };

  let cachedIndex: { index: ProjectIndex; storedAt: number } | null = null;
  async function projectIndex(force: boolean): Promise<ProjectIndex> {
    if (!force && cachedIndex !== null && Date.now() - cachedIndex.storedAt < CACHE_TTL_MS) {
      return cachedIndex.index;
    }
    const projects: readonly ProjectRecord[] = await bb.sdk.projects.list();
    const index = await buildProjectIndex(projects, await localHostId(), localRemotes);
    cachedIndex = { index, storedAt: Date.now() };
    return index;
  }

  async function localHostId(): Promise<string | null> {
    return (await bb.sdk.system.config()).primaryHostId;
  }

  const service = createBoardService({
    api,
    token: (signal) => ghToken(requireGh(), signal),
    configuredLogin: async () => (await settings.get()).login,
    projectIndex,
    localHostId,
    now: () => Date.now(),
  });

  function publishPatch(patch: ItemPatch): void {
    bb.realtime.publish(ITEM_PATCHED, patch);
  }

  async function displayPrefs(): Promise<DisplayPrefs> {
    return { ...DEFAULT_DISPLAY, ...((await bb.storage.kv.get<DisplayPrefs>(DISPLAY_KEY)) ?? {}) };
  }

  async function prompts(): Promise<PromptSettings> {
    const stored = await bb.storage.kv.get<PromptSettings>(PROMPTS_KEY);
    return stored === undefined
      ? { byType: { ...DEFAULT_PROMPTS }, byProject: {} }
      : normalizePrompts({ byType: { ...DEFAULT_PROMPTS, ...stored.byType }, byProject: stored.byProject ?? {} });
  }

  bb.rpc.register(rpcContract, {
    loadBoard: (input) => service.loadBoard(input),
    loadItem: (input) => service.loadItem(input),
    loadComments: (input) => service.loadComments(input),
    loadImage: (input) => service.loadImage(input),
    listLabels: (input) => service.listLabels(input),
    toggleLabel: async (input) => {
      const result = await service.toggleLabel(input);
      publishPatch({ itemId: input.itemId, patch: { labels: result.labels } });
      return result;
    },
    updateBranch: async (input) => {
      const result = await service.updateBranch(input);
      publishPatch({ itemId: input.id, patch: { branch: result.branch } });
      return result;
    },
    getDisplayPrefs: () => displayPrefs(),
    setDisplayPrefs: async (patch) => {
      const next = { ...(await displayPrefs()), ...patch };
      await bb.storage.kv.set(DISPLAY_KEY, next);
      bb.realtime.publish(DISPLAY_PREFS_CHANGED, next);
      return next;
    },
    getPrompts: () => prompts(),
    savePrompts: async (value) => {
      const next = normalizePrompts(value);
      await bb.storage.kv.set(PROMPTS_KEY, next);
      bb.realtime.publish(PROMPTS_CHANGED, next);
      return next;
    },
    sendOptions: async ({ repository, url }) => {
      const [{ project, candidates }, launch] = await Promise.all([
        service.projectsForCard({ repository, url }),
        bb.storage.kv.get<LaunchDefaults>(LAUNCH_KEY),
      ]);
      const choice = (ref: { id: string; name: string }) => ({ id: ref.id, name: ref.name });
      return {
        project: project === null ? null : choice(project),
        candidates: candidates.map(choice),
        launch: launch ?? null,
      };
    },
    send: async ({ card, request }) => {
      // The composer's request goes to bb as it built it; bb validates it.
      // The card rides along as this plugin's metadata on the thread, since
      // no plugin API can add a row of its own to a thread's timeline.
      const thread = await bb.sdk.threads.spawn({
        ...(request as unknown as SpawnArgs),
        title: workspaceTitle(card.repository, card.number, card.title),
        pluginMetadata: { card },
      });
      // Saved only once the thread exists, so a selection bb refused is not
      // what the next card opens on.
      const launch: LaunchDefaults = {
        providerId: request.providerId,
        model: request.model,
        reasoningLevel: request.reasoningLevel,
        permissionMode: request.permissionMode,
        ...(request.serviceTier === undefined ? {} : { serviceTier: request.serviceTier }),
        environment: request.environment,
      };
      await bb.storage.kv.set(LAUNCH_KEY, launch);
      bb.log.info(`started thread ${thread.id} on ${card.repository}#${card.number}`);
      return { threadId: thread.id };
    },
  });
}
