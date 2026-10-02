/**
 * The `/fm` skill (`skills/fm/`). bb copies a plugin's skill directories into every thread as they are,
 * so this test lives here rather than beside the skill, where it would be copied too.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SKILL_DIR = new URL("../skills/fm/", import.meta.url);

async function skillFile(): Promise<{ frontmatter: string; body: string }> {
  const text = await readFile(new URL("SKILL.md", SKILL_DIR), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match === null) throw new Error("skills/fm/SKILL.md has no frontmatter");
  return { frontmatter: match[1]!, body: match[2]! };
}

describe("the /fm skill", () => {
  it("is named fm, and only the user can start it", async () => {
    const { frontmatter } = await skillFile();
    expect(frontmatter).toMatch(/^name: fm$/m);
    // Claude Code: hidden from the model, still typed as /fm. Codex: no implicit use.
    expect(frontmatter).toMatch(/^disable-model-invocation: true$/m);
    const codex = await readFile(new URL("agents/openai.yaml", SKILL_DIR), "utf8");
    expect(codex).toMatch(/^policy:\n {2}allow_implicit_invocation: false$/m);
  });

  it("pipes the request as one base64 line into tell, and asks for the request when there is none", async () => {
    const { body } = await skillFile();
    expect(body).toContain("base64 <<'FM_REQUEST_END' | tr -d '\\n' | bb firstmate-crew tell --message-base64-stdin");
    expect(body).toContain("ask the user what to send");
  });

  it("holds nothing Claude Code would replace before the agent reads it", async () => {
    const { body } = await skillFile();
    // `$ARGUMENTS`, `$0`…`$9` and `${CLAUDE_…}` are substituted, and "!" before a backtick runs a command.
    expect(body).not.toMatch(/\$ARGUMENTS|\$\d|\$\{CLAUDE_|!`/);
  });
});
