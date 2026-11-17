/**
 * The dream's prompt: the `dream` skill (skills/dream/SKILL.md, embedded as `DREAM_SKILL`) with one
 * run's facts filled in. The skill is native auto-dream's prompt from Claude Code 2.1.326, adapted
 * where a bb dream differs: the transcripts are a manifest across several folders, the checkout is
 * read from outside the session's working directory, and native's "Reconcile memories against
 * CLAUDE.md" section, which 2.1.326 ships but leaves out of its prompt, is in.
 */
import type { ManifestEntry } from "../shared/types";
import { DREAM_SKILL } from "./dream-skill";

export interface PromptFacts {
  targetDir: string;
  checkout: string;
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
    transcriptFolders: facts.transcriptFolders.length > 0 ? facts.transcriptFolders.map((folder) => `- \`${folder}\``).join("\n") : "- (none: no session since the last dream)",
    sessionCount: String(facts.sessionCount),
    sessions: listed.length > 0 ? listed.join("\n") : "- (none)",
    instructionFiles: facts.instructionFiles.length > 0 ? facts.instructionFiles.map((file) => `\`${file}\``).join(", ") : "none (the project has no CLAUDE.md or AGENTS.md)",
  };
  return skillBody(skill).replace(/\{\{(\w+)\}\}/g, (whole, name: string) => values[name] ?? whole);
}
