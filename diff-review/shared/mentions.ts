/**
 * `@claude`, `@codex` and `@opencode` in a comment, outside code: the agent that should answer it.
 *
 * Ported from diffity's `src/lib/mentions.ts` (https://github.com/nilbuild/diffity), Copyright (c)
 * 2026 Kamran Ahmed, MIT License — see THIRD_PARTY_NOTICES.md. Same rules: case-insensitive, whole
 * word, not inside a fenced block or an inline code span, not part of an email address or a path.
 */

/** Mention handles, and the bb provider each one starts. */
export const AGENT_HANDLES = {
  claude: "claude-code",
  codex: "codex",
  opencode: "opencode",
} as const;

export type AgentHandle = keyof typeof AGENT_HANDLES;

function stripCode(body: string): string {
  const out: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  for (const line of body.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      const closes = marker !== null && marker[1]![0] === fence.ch && marker[1]!.length >= fence.len && line.trim() === marker[1];
      if (closes) fence = null;
      out.push("");
      continue;
    }
    if (marker !== null) {
      fence = { ch: marker[1]![0]!, len: marker[1]!.length };
      out.push("");
      continue;
    }
    out.push(line.replace(/(`+)[\s\S]*?\1(?!`)/g, " "));
  }
  return out.join("\n");
}

const HANDLES = Object.keys(AGENT_HANDLES).join("|");
const MENTION = new RegExp(`(^|[^\\p{L}\\p{N}_\\-@./])(@(${HANDLES}))(?![\\p{L}\\p{N}_\\-@/]|\\.[\\p{L}\\p{N}_-])`, "iu");

/** The handle of the earliest agent mention outside code, if any. */
export function mentionedAgent(body: string): AgentHandle | null {
  const match = MENTION.exec(stripCode(body));
  return match === null ? null : (match[3]!.toLowerCase() as AgentHandle);
}
