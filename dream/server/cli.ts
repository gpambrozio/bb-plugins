/**
 * `bb dream`: the dream schedule's state per project, and the by-hand actions — run one dream,
 * apply or discard a dry run, restore a backup, stop the running dream. A project is named by its
 * bb name or id. Built with `defineCli`, so parsing, `--help` and the `--json` error envelope are
 * the SDK's.
 */
import { PluginCliError, cliCommand, defineCli, type PluginCliRegistration } from "@get-bb/plugin-sdk";

import type { Overview, RunRecord } from "../shared/contract-types";
import type { Changes, ProjectStatus } from "../shared/types";
import { stampTime } from "../host/snapshot";
import { changeText, DreamError, type DreamService } from "./service";

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    throw new PluginCliError(reason(error), { code: error instanceof DreamError ? "refused" : "failed" });
  }
}

function output(json: boolean, data: unknown, text: string) {
  return { exitCode: 0, stdout: `${json ? JSON.stringify(data, null, 2) : text}\n` };
}

function when(ms: number | null): string {
  if (ms === null) return "never";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function stampText(stamp: string): string {
  const ms = stampTime(stamp);
  return ms === null ? stamp : `${stamp} (${when(ms)})`;
}

function sizeText(bytes: number | null): string {
  if (bytes === null) return "";
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

const SOURCE_TEXT: Record<ProjectStatus["memory"]["source"], string> = {
  env: "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE",
  policySettings: "managed settings",
  localSettings: ".claude/settings.local.json",
  projectSettings: ".claude/settings.json",
  userSettings: "~/.claude/settings.json",
  default: "default",
};

export function projectText(status: ProjectStatus): string {
  const { memory, gate } = status;
  const index = memory.indexLines === null ? "no MEMORY.md" : `MEMORY.md ${memory.indexLines} lines, ${sizeText(memory.indexBytes)}`;
  const lines = [
    `${status.name} (${status.projectId}) — ${gate.due ? "due" : "not due"}: ${gate.reason}`,
    `  memory      ${memory.dir} (${SOURCE_TEXT[memory.source]}) · ${memory.files} files · ${index}`,
    `  last dream  ${when(gate.lastDreamAt)} · ${gate.sessionsSince} sessions on ${gate.daysSince} days since${gate.lastDreamAt === null && gate.baselineAt !== null ? ` the last memory change (${when(gate.baselineAt)})` : ""}`,
    `  sessions    ${status.sessions} in ${status.folders} transcript folders · switch ${status.enabled ? "on" : "off"} · ${status.inPlace ? "edits in place" : "next dream is a dry run"}`,
  ];
  if (status.pendingProposal) lines.push(`  proposal    ${stampText(status.pendingProposal.stamp)} waits: bb dream apply ${status.name}, or bb dream discard ${status.name}`);
  if (status.lastBackup) lines.push(`  backup      ${stampText(status.lastBackup)}`);
  for (const warning of memory.warnings) lines.push(`  ! ${warning}`);
  return lines.join("\n");
}

export function overviewText(overview: Overview): string {
  const { schedule } = overview;
  const head = [
    `Dream machine: ${overview.host?.name ?? "unknown"}${overview.host && !overview.host.connected ? " (offline)" : ""}`,
    `Schedule: ${schedule.enabled ? "on" : "off"}, ${schedule.windowStart}–${schedule.windowEnd}${schedule.enabled && schedule.inWindow ? " (window open)" : ""}`,
  ];
  if (overview.active) head.push(`Running: ${overview.active.projectName} (${overview.active.mode}), since ${when(overview.active.startedAt)}, thread ${overview.active.threadId ?? "starting"}`);
  if (overview.error) head.push(`! ${overview.error}`);
  const projects = overview.projects.length > 0 ? overview.projects.map(projectText) : ["No project has a checkout on the dream machine."];
  return [...head, "", ...projects].join("\n\n").replace(/\n\n\n/g, "\n\n");
}

function changesText(changes: Changes | null): string {
  return changes === null ? "" : changeText(changes);
}

export function runText(run: RunRecord): string {
  const head = `${when(run.startedAt)}  ${run.projectName}  ${run.mode}  ${run.outcome}${run.changes ? ` — ${changesText(run.changes)}` : ""}`;
  const lines = [head];
  if (run.error) lines.push(`  ${run.error}`);
  if (run.backup) lines.push(`  backup ${run.backup}`);
  if (run.proposal) lines.push(`  proposal ${run.proposal}`);
  if (run.threadId) lines.push(`  thread ${run.threadId}`);
  if (run.summary) lines.push(...run.summary.trim().split("\n").map((line) => `  │ ${line}`));
  return lines.join("\n");
}

const JSON_OPTION = { json: { type: "boolean", description: "Print the result as JSON" } } as const;
const PROJECT = { name: "project", description: "The project's bb name or id", required: true } as const;
const TIME = { name: "time", description: "Which one, by its time stamp (as `bb dream backups` lists them); the newest when left out" } as const;

export function dreamCli(service: DreamService): PluginCliRegistration {
  return defineCli({
    name: "dream",
    summary: "Consolidate Claude Code projects' memory on a schedule, as Claude Code's auto-dream does",
    description:
      "Each dream is a hidden bb thread limited to reading and to writing the project's memory folder. A project's first dream is a dry run whose proposal you apply or discard. The schedule is off until you turn it on in the plugin's settings.",
    commands: {
      status: cliCommand({
        summary: "Show each project's memory folder, last dream, sessions since and whether it is due",
        options: JSON_OPTION,
        run: (input) =>
          guarded(async () => {
            const overview = await service.overview();
            return output(input.options.json, overview, overviewText(overview));
          }),
      }),
      run: cliCommand({
        summary: "Dream one project now, whether or not it is due",
        description:
          "Skips the time, session and busy checks, not the lock. A project whose proposal was never applied gets a dry run; --dry-run always makes one. Answers once the dream thread has started; the dream runs on, and `bb dream status` and the Dream page show it.",
        options: { ...JSON_OPTION, "dry-run": { type: "boolean", description: "Propose the changes in a copy instead of editing the memory" } },
        positionals: [PROJECT],
        run: (input) =>
          guarded(async () => {
            const project = await service.findProject(input.positionals.project);
            const { record } = await service.begin(project.projectId, { mode: input.options["dry-run"] ? "dry-run" : null, manual: true, trigger: "manual" });
            const text = `Started a ${record.mode === "dry-run" ? "dry run" : "dream"} of ${record.projectName} in hidden thread ${record.threadId}.${
              record.mode === "dry-run" ? " Its proposal waits for `bb dream apply` when it ends." : ""
            }`;
            return output(input.options.json, record, text);
          }),
      }),
      stop: cliCommand({
        summary: "Stop the running dream; its memory lock is rolled back",
        options: JSON_OPTION,
        run: (input) =>
          guarded(async () => {
            const stopped = await service.stopActive();
            return output(input.options.json, { stopped }, stopped ? "Stopping the running dream." : "No dream is running.");
          }),
      }),
      apply: cliCommand({
        summary: "Apply a dry run's proposal to the project's memory, after a backup",
        description: "Refused when a file the dream changed has changed in the memory since. Afterwards the project's dreams edit in place.",
        options: JSON_OPTION,
        positionals: [PROJECT, TIME],
        run: (input) =>
          guarded(async () => {
            const project = await service.findProject(input.positionals.project);
            const result = await service.apply(project.projectId, input.positionals.time);
            return output(input.options.json, result, `Applied the dry run from ${stampText(result.stamp)} to ${project.name}: ${changeText(result.changes)}. Backup ${result.backup}.`);
          }),
      }),
      discard: cliCommand({
        summary: "Discard a dry run's proposal; the next one waits for new sessions",
        options: JSON_OPTION,
        positionals: [PROJECT, TIME],
        run: (input) =>
          guarded(async () => {
            const project = await service.findProject(input.positionals.project);
            const result = await service.discard(project.projectId, input.positionals.time);
            return output(input.options.json, result, `Discarded the dry run from ${stampText(result.stamp)} for ${project.name}.`);
          }),
      }),
      restore: cliCommand({
        summary: "Put a backup's memory files back, after backing up the current ones",
        description: "Only .md files change. Restoring the newest backup right after a restore undoes it.",
        options: JSON_OPTION,
        positionals: [PROJECT, TIME],
        run: (input) =>
          guarded(async () => {
            const project = await service.findProject(input.positionals.project);
            const result = await service.restore(project.projectId, input.positionals.time);
            return output(input.options.json, result, `Restored ${project.name}'s memory from ${stampText(result.stamp)}: ${changeText(result.changes)}. The memory as it was is backup ${result.backup}.`);
          }),
      }),
      backups: cliCommand({
        summary: "List a project's backups and dry runs",
        options: JSON_OPTION,
        positionals: [PROJECT],
        run: (input) =>
          guarded(async () => {
            const project = await service.findProject(input.positionals.project);
            const result = await service.backups(project.projectId);
            const lines = [
              `Backups of ${project.name}, newest first:`,
              ...(result.backups.length > 0 ? result.backups.map((entry) => `  ${stampText(entry.stamp)}  ${sizeText(entry.size)}`) : ["  none"]),
              "Dry runs:",
              ...(result.proposals.length > 0
                ? result.proposals.map((proposal) => (proposal ? `  ${stampText(proposal.stamp)}  ${proposal.status}${proposal.changes ? ` — ${changeText(proposal.changes)}` : ""}  ${proposal.dir}` : ""))
                : ["  none"]),
            ];
            return output(input.options.json, result, lines.join("\n"));
          }),
      }),
      history: cliCommand({
        summary: "Show past dreams with their summaries, newest first",
        options: { ...JSON_OPTION, limit: { type: "integer", description: "How many (default 10)", min: 1, max: 300 } },
        positionals: [{ name: "project", description: "Only this project's dreams" }],
        run: (input) =>
          guarded(async () => {
            const projectId = input.positionals.project === undefined ? undefined : (await service.findProject(input.positionals.project)).projectId;
            const runs = await service.history.list(input.options.limit ?? 10, projectId);
            return output(input.options.json, runs, runs.length > 0 ? runs.map(runText).join("\n\n") : "No dreams yet.");
          }),
      }),
    },
  });
}
