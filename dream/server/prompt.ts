/**
 * The dream's prompt: the `dream` skill (skills/dream/SKILL.md, embedded as `DREAM_SKILL`) with one
 * run's facts filled in. The skill is native auto-dream's prompt from Claude Code 2.1.326, adapted
 * where a bb dream differs: the transcripts are a manifest across several folders, the checkout is
 * read from outside the session's working directory, and native's "Reconcile memories against
 * CLAUDE.md" section, which 2.1.326 ships but leaves out of its prompt, is in.
 */
import type { CodeSource, ManifestEntry } from "../shared/types";
import { DREAM_SKILL } from "./dream-skill";
import { MAX_DREAM_MS } from "./limits";

export interface PromptFacts {
  targetDir: string;
  checkout: string;
  code: CodeSource;
  transcriptFolders: readonly string[];
  sessions: readonly ManifestEntry[];
  sessionCount: number;
  instructionFiles: readonly string[];
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function manifestLine(entry: ManifestEntry): string {
  return `- ${entry.date} · ${entry.title ?? "(untitled)"} · ${sizeText(entry.size)} · ${entry.path}`;
}

function shortOf(commit: string | null): string {
  return commit === null ? "?" : commit.slice(0, 8);
}

function day(ms: number | null): string {
  return ms === null ? "an unknown date" : new Date(ms).toISOString().slice(0, 10);
}

/** The prompt's line about the code the dream checks memories against, ending with never to change it. */
export function codeText(code: CodeSource, checkout: string): string {
  if (code.kind === "copy") {
    return `\`${code.dir}\`, a read-only copy of the default branch \`${code.branch}\` at ${shortOf(code.commit)} (from \`${code.ref}\`, committed ${day(code.committedAt)}), the newest the repository has. The checkout \`${checkout}\` is at ${shortOf(code.checkoutCommit)} (committed ${day(code.checkoutCommittedAt)}) and may be behind or on another branch: check memories against the copy, and read the checkout only for work that is not on \`${code.branch}\` yet. Never change either.`;
  }
  if (code.note === null) {
    return `\`${code.dir}\`, the checkout, at the default branch \`${code.branch}\`'s newest commit ${shortOf(code.commit)} (committed ${day(code.committedAt)}). Never change it.`;
  }
  return `\`${code.dir}\`, the checkout (${code.note}, so it may be behind the project). Never change it.`;
}

/** The skill's body: everything after its front matter. */
export function skillBody(skill: string): string {
  const match = /^---\n[\s\S]*?\n---\n/.exec(skill);
  return match ? skill.slice(match[0].length) : skill;
}

export function renderPrompt(facts: PromptFacts, skill = DREAM_SKILL): string {
  const listed = facts.sessions.map(manifestLine);
  if (facts.sessionCount > facts.sessions.length) listed.push(`- … and ${facts.sessionCount - facts.sessions.length} older sessions in the same folders`);
  const values: Record<string, string> = {
    memoryDir: facts.targetDir,
    checkout: facts.checkout,
    code: codeText(facts.code, facts.checkout),
    transcriptFolders: facts.transcriptFolders.length > 0 ? facts.transcriptFolders.map((folder) => `- \`${folder}\``).join("\n") : "- (none: no session since the last dream)",
    sessionCount: String(facts.sessionCount),
    timeBudgetMinutes: String(Math.round(MAX_DREAM_MS / 60_000)),
    sessions: listed.length > 0 ? listed.join("\n") : "- (none)",
    instructionFiles: facts.instructionFiles.length > 0 ? facts.instructionFiles.map((file) => `\`${file}\``).join(", ") : "none (the project has no CLAUDE.md or AGENTS.md)",
  };
  return skillBody(skill).replace(/\{\{(\w+)\}\}/g, (whole, name: string) => values[name] ?? whole);
}
