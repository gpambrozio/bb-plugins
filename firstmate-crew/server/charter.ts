/**
 * The first mate's charter: the `AGENTS.md` written into its home.
 *
 * The charter is the port of FirstMate's operating contract — the part of that
 * distro that is behaviour rather than plumbing. Everything it did with tmux
 * panes, treehouse worktrees, a bash watcher and status files is done with bb's
 * own pieces: `bb firstmate-crew crew spawn` (`cli.ts`) starts a crewmate as a child
 * thread of the first mate in a new worktree, bb's message to a parent when a
 * child's turn ends is the wake-up, and the crewmate's last line is its status.
 *
 * Its words are `templates/data/charter.md`, and the home keeps a copy the
 * captain can edit, `data/charter.md` (`charter-file.ts`). This renders
 * `AGENTS.md` from that copy — into `templates/AGENTS.md`, which heads it with
 * a note — whenever the plugin loads and whenever the first mate is launched,
 * adopted or restarted, so a change reaches the home on the next reload and the
 * first mate at its next session, or at once when it is asked to re-read the file.
 *
 * `{{name}}` placeholders are filled here: the home, and the crew's model and
 * reasoning level as sentences from `templates/parts/`, one for a setting left
 * open and one for a setting chosen. `crew spawn` applies those settings itself;
 * the sentences only tell the first mate when to pass its own.
 */
import { TEMPLATES, fill, readTemplate, withoutNotes, type TemplatePath } from "./templates";

export interface CharterValues {
  /** Absolute path of the first mate's home. */
  home: string;
  /** `provider/model` for crewmates, or empty to leave it to the first mate. */
  crewProvider: string;
  /** Reasoning level for crewmates, or empty to leave it to the first mate. */
  crewReasoning: string;
}

/** The plugin's own charter, as the home's copy starts: notes left out, placeholders unfilled. */
export async function pluginCharter(): Promise<string> {
  return withoutNotes(await readTemplate(TEMPLATES.charter));
}

/** A part from `templates/parts/`, notes left out and its own placeholders filled. */
async function part(path: TemplatePath, values: Record<string, string>): Promise<string> {
  return fill(withoutNotes(await readTemplate(path)), values);
}

/** `AGENTS.md`: `charter` — the captain's copy, or by default the plugin's — filled in and under its heading note. */
export async function renderCharter(values: CharterValues, charter?: string): Promise<string> {
  const crewProvider = values.crewProvider.trim();
  const crewReasoning = values.crewReasoning.trim();
  const [template, agents, crewProviderRule, crewReasoningRule] = await Promise.all([
    charter ?? pluginCharter(),
    readTemplate(TEMPLATES.agents),
    crewProvider === ""
      ? part(TEMPLATES.crewProviderOpen, {})
      : part(TEMPLATES.crewProviderChosen, { crewProvider }),
    crewReasoning === ""
      ? part(TEMPLATES.crewReasoningOpen, {})
      : part(TEMPLATES.crewReasoningChosen, { crewReasoning }),
  ]);
  const body = fill(template, {
    home: values.home,
    crewProviderRule,
    crewReasoningRule,
  });
  return `${fill(agents, { charter: body.trim() }).trimEnd()}\n`;
}
