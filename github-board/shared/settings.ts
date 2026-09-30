/**
 * The prompt templates a card is sent with, and the rules for reading and
 * saving them. Both halves use this: the app resolves a card's template before
 * the send dialog opens, and whatever saves the templates normalises them.
 *
 * Like every `shared/` module it imports no Node and no React.
 */
import { COLUMN_IDS, type BoardItem, type ColumnId, type PromptSet, type PromptSettings } from "./board";

/**
 * What the send dialog opens with, before the user changes it. Each one names
 * the kind of work its column holds, because "read this URL" alone tells an
 * agent nothing about whether it is being asked to fix, finish, or review.
 */
export const DEFAULT_PROMPTS: PromptSet = {
  issues: "Read issue {url}, investigate and give me ways to address it.",
  "draft-prs": "Read draft pull request {url} and help me finish it.",
  "open-prs": "Review pull request {url} and tell me what needs attention.",
  discussions: "Read discussion {url} and summarise what is being decided.",
};

/** Every placeholder a template may use, shown to the user in the settings view. */
export const PLACEHOLDERS = ["{url}", "{title}", "{number}", "{repository}"] as const;

const PROMPT_KEYS: readonly (keyof PromptSet)[] = COLUMN_IDS;

/**
 * Blank means "inherit", at both levels: a missing or empty `byType` entry
 * becomes the built-in default, and a missing or empty override is dropped so
 * the card falls back to `byType`. That is what makes clearing a field the way
 * to reset it, rather than a separate action — and it is why an override never
 * stores a copy of the inherited value, which would freeze a default the user
 * later edits.
 *
 * Applied at the save boundary rather than on read, so the settings editor's
 * draft can hold a blank field while it is being cleared.
 */
export function normalizePrompts(value: PromptSettings): PromptSettings {
  const byType = { ...DEFAULT_PROMPTS };
  for (const key of PROMPT_KEYS) {
    const template = value.byType[key];
    byType[key] = template.trim() === "" ? DEFAULT_PROMPTS[key] : template;
  }

  const byProject: PromptSettings["byProject"] = {};
  for (const [projectId, overrides] of Object.entries(value.byProject)) {
    const kept: Partial<PromptSet> = {};
    for (const key of PROMPT_KEYS) {
      const template = overrides[key];
      if (template !== undefined && template.trim() !== "") kept[key] = template;
    }
    if (Object.keys(kept).length > 0) byProject[projectId] = kept;
  }
  return { byType, byProject };
}

/**
 * A project override wins over the type template, and a blank one does not
 * count — blank means inherit, which is what makes clearing a field the way to
 * drop an override. A card whose repository reaches no project has no override
 * to find, which is fine: it cannot be sent anywhere either.
 */
export function templateFor(
  prompts: PromptSettings,
  type: ColumnId,
  projectId: string | null,
): string {
  const override = projectId === null ? undefined : prompts.byProject[projectId]?.[type];
  return override !== undefined && override.trim() !== "" ? override : prompts.byType[type];
}

/**
 * Substitutes the card's own fields. An unrecognised placeholder is left
 * standing rather than blanked, so a typo shows up in the prompt instead of
 * silently swallowing part of it.
 */
export function renderTemplate(
  template: string,
  item: Pick<BoardItem, "url" | "title" | "number" | "repository">,
): string {
  return template.replace(/\{(url|title|number|repository)\}/g, (_match, key: string) => {
    if (key === "url") return item.url;
    if (key === "title") return item.title;
    if (key === "number") return String(item.number);
    return item.repository;
  });
}
