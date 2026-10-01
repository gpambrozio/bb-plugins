/**
 * One summary is one short-lived bb thread: spawned **hidden**, so it stays out
 * of the sidebar and out of bb's unread attention, in the personal workspace,
 * so it needs no checkout. It is not a child of the thread it describes — a
 * child notifies its parent when it finishes, and that would put a message in
 * the user's own thread.
 *
 * A hidden thread still fires this plugin's events. `server/hooks.ts`
 * recognises the helpers by `originPluginId` (bb stamps it on every thread a
 * plugin spawns) and hands their events to `HelperOutcomes`, which is what
 * `summarize` waits on.
 *
 * Whatever happens, the helper is stopped, which releases its agent runtime,
 * and then deleted — or archived, when the user keeps helpers to read later.
 * The sentence is available as soon as the helper answers (`result`), but the
 * run is not over until the helper is put away (`finished`): the caller holds
 * its concurrency slot until then, so stopping helpers never pile up.
 *
 * bb cannot make a helper tool-free — see "Summaries need a model that can use
 * tools" in AGENTS.md — so this runs only when the user has switched model
 * summaries on.
 */
import { DEFAULT_SUMMARY_PROMPT, type AttentionReason, type PromptPlaceholder } from "../shared/herald";
import type { HelperOutcome } from "./helpers";
import type { HelperPort, Log } from "./ports";
import { displayName, firstWords, preview } from "./timeline";

export const HELPER_TITLE = "Herald summary";

/** Enough of a final message for a summary; the rest is never what the user needs to hear. */
const MAX_OUTPUT_CHARS = 6000;
const MAX_USER_CHARS = 600;
/** A model asked for 35 words can still answer with a page; the voice says the start. */
export const MAX_SUMMARY_CHARS = 400;

export interface SummaryRequest {
  thread: {
    id: string;
    title: string | null;
    projectName: string | null;
    folder: string | null;
  };
  eventId: string;
  reason: AttentionReason;
  headline: string;
  detail: string | null;
  /** What the agent said at the end of its turn; empty for a pause. */
  output: string;
  lastUser: string | null;
}

export interface SummarizerDeps {
  helpers: HelperPort;
  /** Resolves with how the helper's turn ended; rejects at the timeout. */
  waitForOutcome: (helperId: string, timeoutMs: number) => Promise<HelperOutcome>;
  /** Called once the helper is put away, so its events stop being tracked. */
  forgetHelper?: (helperId: string) => void;
  providerId: string;
  model: string;
  reasoningLevel: string;
  timeoutMs: number;
  /** The user's prompt template. Blank or absent means the default one. */
  prompt?: string;
  /** Delete the helper when it is done, rather than leaving an archived thread behind. */
  deleteHelper: boolean;
  log: Log;
}

export interface Summary {
  text: string;
  model: string;
}

export interface SummaryRun {
  /** The sentence, or why there is none. */
  result: Promise<Summary>;
  /** Settles once the helper is stopped and deleted or archived. Never rejects. */
  finished: Promise<void>;
}

/** Everything the helper wrote in code fences, with the fences and language tags removed. */
function stripFences(text: string): string {
  return text.replace(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g, "$1").trim();
}

/**
 * The sentence inside the helper's JSON: the `speech` property the prompt asks
 * for, or — because a model has been seen answering under `spoken` — whatever
 * the first non-empty string property is.
 */
function sentenceIn(json: unknown): string | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;
  const preferred = record.speech;
  if (typeof preferred === "string" && preferred.trim() !== "") return preferred;
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

function describeReason(reason: AttentionReason): string {
  switch (reason) {
    case "question":
      return "The agent has paused to ask the user a question.";
    case "plan":
      return "The agent has written a plan and is waiting for the user to approve it.";
    case "permission":
      return "The agent has paused for permission to do something.";
    case "finished":
      return "The agent finished its turn and is waiting for the user.";
    case "error":
      return "The agent's turn failed with an error.";
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[…truncated]`;
}

/** What each `{{placeholder}}` is worth for one event. Empty means "not there for this one". */
export function promptValues(request: SummaryRequest): Record<PromptPlaceholder, string> {
  const folder = request.thread.folder?.trim() ?? "";
  const name =
    displayName({ projectName: request.thread.projectName, threadTitle: request.thread.title }) ?? (folder || "a thread");
  return {
    thread: name,
    project: request.thread.projectName?.trim() || folder,
    folder,
    event: describeReason(request.reason),
    headline: request.headline.trim(),
    detail: request.detail?.trim() ?? "",
    request: request.lastUser === null ? "" : clip(request.lastUser.trim(), MAX_USER_CHARS),
    output: request.output.trim() === "" ? "" : clip(request.output.trim(), MAX_OUTPUT_CHARS),
  };
}

/**
 * The user's template with this event's values in it.
 *
 * Two rules, both of them things the settings section tells the user:
 *
 * - **A line whose placeholder is empty for this event is left out whole.**
 *   That is what keeps `Detail: {{detail}}` from reaching the model as a bare
 *   `Detail:` when the event carries none, without the template needing any
 *   notion of a conditional. Runs of blank lines left behind are collapsed.
 * - **A name we do not know is left exactly as typed**, so a prompt that talks
 *   about `{{ }}` for its own reasons is not quietly mangled.
 */
export function renderPrompt(template: string, values: Readonly<Record<string, string>>): string {
  const kept: string[] = [];
  for (const line of template.split("\n")) {
    let missing = false;
    const rendered = line.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (whole, name: string) => {
      const value = values[name];
      if (value === undefined) return whole;
      if (value === "") missing = true;
      return value;
    });
    if (missing) continue;
    if (rendered.trim() === "" && kept[kept.length - 1]?.trim() === "") continue;
    kept.push(rendered);
  }
  return kept.join("\n").trim();
}

export function buildPrompt(request: SummaryRequest, template?: string): string {
  const chosen = template === undefined || template.trim() === "" ? DEFAULT_SUMMARY_PROMPT : template;
  return renderPrompt(chosen, promptValues(request));
}

/**
 * The model is asked for an object, and that is a request, not a guarantee:
 * against a live host Claude has returned the object inside a ```json fence,
 * and once under a key of its own choosing. So: fences off, then the JSON
 * object anywhere in the text, then any string in it; and a model that wrote
 * plain prose instead is still worth hearing, so that is the last resort
 * rather than a failure.
 */
export function parseSummaryText(lastMessage: string | null): string {
  const raw = lastMessage?.trim() ?? "";
  if (raw === "") throw new Error("The summary helper returned nothing.");
  const unfenced = stripFences(raw);
  const candidates = [unfenced];
  const braces = unfenced.match(/\{[\s\S]*\}/);
  if (braces !== null && braces[0] !== unfenced) candidates.push(braces[0]);
  for (const candidate of candidates) {
    try {
      const sentence = sentenceIn(JSON.parse(candidate));
      if (sentence !== null) return preview(sentence, MAX_SUMMARY_CHARS);
    } catch {
      // Not JSON; try the next candidate.
    }
  }
  return firstWords(unfenced, 45);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The helper's last rites: stopped first, whatever its state — that is what
 * releases its runtime and interrupts a turn still running after a timeout —
 * then deleted or archived. Failures are logged, never thrown.
 */
async function retire(helperId: string, deps: SummarizerDeps): Promise<void> {
  try {
    await deps.helpers.stop(helperId);
  } catch (error) {
    deps.log.warn(`Could not stop summary helper ${helperId}: ${reasonOf(error)}`);
  }
  try {
    if (deps.deleteHelper) await deps.helpers.delete(helperId);
    else await deps.helpers.archive(helperId);
  } catch (error) {
    deps.log.warn(`Could not ${deps.deleteHelper ? "delete" : "archive"} summary helper ${helperId}: ${reasonOf(error)}`);
  } finally {
    deps.forgetHelper?.(helperId);
  }
}

function sentenceFrom(outcome: HelperOutcome, deps: SummarizerDeps): Summary {
  switch (outcome.kind) {
    case "interaction":
      // Asking anything — a tool approval included — is not allowed; stopping
      // the helper in `retire` interrupts whatever it was asking for.
      throw new Error("The summary helper tried to use a tool.");
    case "failed":
      throw new Error(outcome.error?.trim() || "The summary helper's turn failed.");
    case "idle":
      return { text: parseSummaryText(outcome.text), model: `${deps.providerId}/${deps.model}` };
  }
}

export function summarize(request: SummaryRequest, deps: SummarizerDeps): SummaryRun {
  let retirement: Promise<void> = Promise.resolve();
  const result = (async () => {
    const helperId = await deps.helpers.spawn({
      title: HELPER_TITLE,
      prompt: buildPrompt(request, deps.prompt),
      providerId: deps.providerId,
      model: deps.model,
      reasoningLevel: deps.reasoningLevel,
      metadata: { role: "summarizer", threadId: request.thread.id, eventId: request.eventId },
    });
    try {
      return sentenceFrom(await deps.waitForOutcome(helperId, deps.timeoutMs), deps);
    } finally {
      retirement = retire(helperId, deps);
    }
  })();
  const finished = result.then(
    () => retirement,
    () => retirement,
  );
  return { result, finished };
}
