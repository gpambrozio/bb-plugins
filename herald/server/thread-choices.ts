/**
 * Each thread's choice of what Herald announces, read and written through bb:
 * the choice lives in Herald's plugin metadata on the thread, and a thread
 * without one inherits from the nearest thread above it that has one. The
 * rule itself is `shared/thread-choice.ts`; this module only gathers its
 * inputs, in as few calls as bb allows — one for the ancestors, one for every
 * thread's metadata — for the hooks (one thread per event) and for the thread
 * menu (every row on screen at once).
 */
import { CHOICES_BATCH_MAX, inputsFrom, NO_CHOICE, type ChoiceInputs, type ChoiceOption, type ThreadChoice } from "../shared/thread-choice";
import type { ThreadChoicesPort } from "./ports";

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += CHOICES_BATCH_MAX) out.push(items.slice(start, start + CHOICES_BATCH_MAX));
  return out;
}

export class ThreadChoices {
  constructor(private readonly port: ThreadChoicesPort) {}

  /** The inputs for each of these threads that bb knows; unknown ids are left out. */
  async inputs(threadIds: readonly string[]): Promise<Map<string, ChoiceInputs>> {
    const unique = [...new Set(threadIds)];
    const lineages: Array<{ threadId: string; ancestorIds: string[] }> = [];
    for (const chunk of chunks(unique)) lineages.push(...(await this.port.ancestors(chunk)));
    const everyone = [...new Set(lineages.flatMap(({ threadId, ancestorIds }) => [threadId, ...ancestorIds]))];
    const own = new Map<string, ThreadChoice>();
    for (const chunk of chunks(everyone)) {
      for (const [threadId, choice] of await this.port.ownChoices(chunk)) own.set(threadId, choice);
    }
    return new Map(lineages.map(({ threadId, ancestorIds }) => [threadId, inputsFrom(threadId, ancestorIds, own)]));
  }

  /** One thread's inputs; a thread bb does not know has no choice. */
  async inputsOf(threadId: string): Promise<ChoiceInputs> {
    return (await this.inputs([threadId])).get(threadId) ?? NO_CHOICE;
  }

  /**
   * Sets the thread's own choice, or clears it for `default`. Only the write:
   * the caller tells the open menus once it lands, then reads the inputs back,
   * so a read that fails cannot hide a change that was made.
   */
  async set(threadId: string, option: ChoiceOption): Promise<void> {
    await this.port.setOwn(threadId, option === "default" ? null : option);
  }
}
