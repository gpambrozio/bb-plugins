/**
 * bb's Git plugin (`bb--git`, bundled and on by default since bb 0.48), which owns every git read:
 * status, the changed files, patches and Viewed marks. It runs git on whichever machine holds the
 * workspace, remote hosts included. bb 0.48 moved these reads out of `bb.sdk.environments`, whose old
 * members are now adapters over the same calls; going to the plugin directly keys patches by the
 * revision `files` returned and says plainly when the user has turned the plugin off.
 *
 * The plugin's contract (`plugins/git/rpc-contract.ts` and `contract.ts` in bb) is not published, so
 * this keeps its own copy of the parts read. The schemas are not strict: a field a later bb adds is
 * dropped, not refused.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

type Sdk = BbPluginApi["sdk"];

export const GIT_PLUGIN_ID = "bb--git";
/** The most keys one `patches` call takes (`GIT_PATCHES_MAX_KEYS`). */
export const GIT_PATCHES_MAX_KEYS = 50;
/** The most paths one `viewed` call takes (`GIT_VIEWED_MAX_PATHS`). */
export const GIT_VIEWED_MAX_PATHS = 500;

export const GIT_PLUGIN_OFF_MESSAGE =
  "bb's Git plugin is turned off, and Diff Review reads every diff through it. Turn Git back on in Settings → Plugins, then reload this tab.";

/** A diff target as the Git plugin names it. */
export type GitTarget =
  | { type: "uncommitted" }
  | { type: "branch_committed" | "all"; mergeBaseBranch: string }
  | { type: "commit"; sha: string };

const notApplicable = z.object({ outcome: z.literal("not_applicable"), message: z.string() });
const unavailable = z.object({ outcome: z.literal("unavailable"), failure: z.object({ message: z.string() }) });

const commitSchema = z.object({ sha: z.string(), shortSha: z.string(), subject: z.string() });

const checkoutSchema = z.object({ kind: z.string(), headSha: z.string().nullable().optional() });

export const gitStatusSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    workspace: z.object({
      checkout: checkoutSchema,
      branch: z.object({ currentBranch: z.string().nullable(), defaultBranch: z.string() }),
      mergeBase: z
        .object({
          mergeBaseBranch: z.string(),
          baseRef: z.string().nullable(),
          aheadCount: z.number(),
          behindCount: z.number(),
          commits: z.array(commitSchema),
        })
        .nullable()
        .optional(),
    }),
  }),
  notApplicable,
  unavailable,
]);
export type GitStatus = z.infer<typeof gitStatusSchema>;

export const gitFileEntrySchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  changeKind: z.enum(["added", "modified", "deleted", "renamed", "copied", "type_changed"]),
  additions: z.number(),
  deletions: z.number(),
  binary: z.boolean(),
  origin: z.enum(["tracked", "untracked"]),
  loadMode: z.enum(["auto", "on_demand", "too_large"]),
  revision: z.string(),
});
export type GitFileEntry = z.infer<typeof gitFileEntrySchema>;

const patchEntrySchema = z.object({ path: z.string(), patch: z.string(), truncated: z.boolean() });
export type GitPatch = z.infer<typeof patchEntrySchema>;

export const gitFilesSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    files: z.array(gitFileEntrySchema),
    truncated: z.boolean(),
    mergeBaseRef: z.string().nullable(),
    initialPatches: z.array(patchEntrySchema),
  }),
  notApplicable,
  unavailable,
]);
export type GitFiles = z.infer<typeof gitFilesSchema>;

const patchRowSchema = z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("available"), patch: patchEntrySchema }), notApplicable, unavailable]);
const patchRowsSchema = z.record(z.string(), patchRowSchema);

const viewedSchema = z.object({ files: z.array(z.object({ path: z.string(), revision: z.string() })) });
const okSchema = z.object({ ok: z.literal(true) });

const fileSideSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), file: z.object({ content: z.string(), contentEncoding: z.enum(["base64", "utf8"]) }) }),
  z.object({ outcome: z.literal("unavailable"), code: z.string(), message: z.string() }),
]);

export type GitFailure = z.infer<typeof notApplicable> | z.infer<typeof unavailable>;

export function failureMessage(result: GitFailure): string {
  return result.outcome === "not_applicable" ? result.message : result.failure.message;
}

/** The plugin's patch key (`gitPatchKey`): one file's patch at one revision. */
export function gitPatchKey(environmentId: string, target: GitTarget, ignoreWhitespace: boolean, path: string, revision: string): string {
  return JSON.stringify([environmentId, target, ignoreWhitespace, path, revision]);
}

/** A file side query (`gitFileSideQuerySchema`). */
export type FileSideQuery =
  | { target: "uncommitted"; path: string; side: "old" | "new" }
  | { target: "branch_committed" | "all"; mergeBaseRef: string; path: string; side: "old" | "new" }
  | { target: "commit"; sha: string; path: string; side: "old" | "new" };

export class GitReads {
  constructor(
    private readonly sdk: Sdk,
    /** Thrown in place of a failed call's own error when the Git plugin is off. */
    private readonly unavailableError: (message: string) => Error,
  ) {}

  /**
   * One call to the Git plugin. A call that fails asks bb whether the plugin is there and on, since a
   * turned-off plugin's error says only that the call failed; otherwise the call's own error stands.
   */
  private async call<T>(method: string, input: Record<string, unknown>, outputSchema: z.ZodType<T>): Promise<T> {
    try {
      return await this.sdk.plugins.callRpc({ pluginId: GIT_PLUGIN_ID, method, input: input as never, outputSchema });
    } catch (error) {
      if (await this.pluginOff()) throw this.unavailableError(GIT_PLUGIN_OFF_MESSAGE);
      throw error;
    }
  }

  private async pluginOff(): Promise<boolean> {
    try {
      const { plugins } = await this.sdk.plugins.list();
      const git = plugins.find((plugin) => plugin.id === GIT_PLUGIN_ID);
      return git === undefined || !git.enabled;
    } catch {
      return false;
    }
  }

  status(environmentId: string, mergeBaseBranch?: string): Promise<GitStatus> {
    return this.call("workspaceStatus", { environmentId, ...(mergeBaseBranch === undefined ? {} : { mergeBaseBranch }) }, gitStatusSchema);
  }

  files(environmentId: string, target: GitTarget, ignoreWhitespace: boolean): Promise<GitFiles> {
    return this.call("files", { environmentId, target, ignoreWhitespace }, gitFilesSchema);
  }

  /**
   * Patches for files at the revisions `files` gave, in batches of `GIT_PATCHES_MAX_KEYS`. A file the
   * plugin could not give is left out; `failure` says why the first one failed.
   */
  async patches(
    environmentId: string,
    target: GitTarget,
    ignoreWhitespace: boolean,
    files: readonly { path: string; revision: string }[],
  ): Promise<{ patches: GitPatch[]; failure: string | null }> {
    const patches: GitPatch[] = [];
    let failure: string | null = null;
    for (let index = 0; index < files.length; index += GIT_PATCHES_MAX_KEYS) {
      const batch = files.slice(index, index + GIT_PATCHES_MAX_KEYS);
      const keys = batch.map((file) => gitPatchKey(environmentId, target, ignoreWhitespace, file.path, file.revision));
      const rows = await this.call("patches", { keys }, patchRowsSchema);
      for (const key of keys) {
        const row = rows[key];
        if (row === undefined) continue;
        if (row.outcome === "available") patches.push(row.patch);
        else failure ??= failureMessage(row);
      }
    }
    return { patches, failure };
  }

  async viewed(environmentId: string, target: GitTarget, paths: readonly string[]): Promise<Map<string, string>> {
    const marks = new Map<string, string>();
    for (let index = 0; index < paths.length; index += GIT_VIEWED_MAX_PATHS) {
      const { files } = await this.call("viewed", { environmentId, target, paths: paths.slice(index, index + GIT_VIEWED_MAX_PATHS) }, viewedSchema);
      for (const file of files) marks.set(file.path, file.revision);
    }
    return marks;
  }

  async markViewed(environmentId: string, target: GitTarget, path: string, revision: string): Promise<void> {
    await this.call("markViewed", { environmentId, target, path, revision }, okSchema);
  }

  async clearViewed(environmentId: string, target: GitTarget, path: string): Promise<void> {
    await this.call("clearViewed", { environmentId, target, path }, okSchema);
  }

  /** One side of a changed file as text, or null when the plugin has none (a new file's old side). */
  async fileSide(environmentId: string, query: FileSideQuery): Promise<string | null> {
    const result = await this.call("fileSide", { environmentId, query }, fileSideSchema);
    if (result.outcome !== "available") return null;
    return result.file.contentEncoding === "base64" ? Buffer.from(result.file.content, "base64").toString("utf8") : result.file.content;
  }
}
