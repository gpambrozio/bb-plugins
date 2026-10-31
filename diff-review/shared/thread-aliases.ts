/**
 * A comment thread folded into another (two local copies of one GitHub thread, see the store's
 * `foldThread`) leaves an alias: its old id names the thread kept. What a tab keeps by thread id (a
 * reply being typed, a fold) follows the alias, on the server and in every open tab, so neither a
 * save made before the fold nor a window's own copy can bring the old id back.
 *
 * Plain functions over plain data: the app imports this at run time, so it must not import the SDK.
 */
import { BODY_MAX_CHARS, type Draft } from "./types";

/** Old thread id → the id of the thread it was folded into. */
export type ThreadAliases = Readonly<Record<string, string>>;

const REPLY = "reply:";

/**
 * Two reply drafts for one thread, `kept` already on it and `moved` from its folded copy: an empty
 * one gives way to the other, the same text is kept once, and two different texts are both kept,
 * one after the other in the reply's editor (nothing is posted until the user presses Reply). The
 * joined text is cut at the comment limit, so a draft near it may lose its end.
 */
export function mergeReplyDrafts(kept: Draft, moved: Draft): Draft {
  if (moved.body.trim() === "" || moved.body.trim() === kept.body.trim()) return kept;
  if (kept.body.trim() === "") return { ...kept, body: moved.body };
  return { ...kept, body: `${kept.body}\n\n${moved.body}`.slice(0, BODY_MAX_CHARS) };
}

/**
 * `state` with each reply draft and thread fold kept under an alias moved to the thread it names
 * (`mergeReplyDrafts` when that thread has a draft too; a fold already there wins), and the keys of
 * the drafts that changed; null when nothing named an alias. Drafts keep their order.
 */
export function remapThreadKeys<State extends { drafts: Record<string, Draft>; expandedThreads?: Record<string, boolean> | undefined }>(
  state: State,
  aliases: ThreadAliases,
): { state: State; changedDrafts: string[] } | null {
  const target = (id: string) => (Object.hasOwn(aliases, id) ? aliases[id] : undefined);
  const named = (key: string) => key.startsWith(REPLY) && target(key.slice(REPLY.length)) !== undefined;
  const folds = Object.keys(state.expandedThreads ?? {}).filter((id) => target(id) !== undefined);
  const moving = Object.keys(state.drafts).filter(named);
  if (moving.length === 0 && folds.length === 0) return null;

  const drafts: Record<string, Draft> = {};
  const changedDrafts = new Set<string>();
  for (const [key, draft] of Object.entries(state.drafts)) {
    if (!named(key)) {
      // A kept thread's own draft after its copy's was already merged into that one.
      if (!Object.hasOwn(drafts, key)) drafts[key] = draft;
      continue;
    }
    const to = `${REPLY}${target(key.slice(REPLY.length))}`;
    const there = Object.hasOwn(drafts, to) ? drafts[to] : Object.hasOwn(state.drafts, to) ? state.drafts[to] : undefined;
    drafts[to] = there === undefined ? draft : mergeReplyDrafts(there, draft);
    changedDrafts.add(to);
  }

  let expandedThreads = state.expandedThreads;
  if (folds.length > 0 && state.expandedThreads !== undefined) {
    const next: Record<string, boolean> = {};
    for (const [id, expanded] of Object.entries(state.expandedThreads)) {
      const to = target(id);
      if (to === undefined) next[id] = expanded;
      else if (!Object.hasOwn(state.expandedThreads, to) && !Object.hasOwn(next, to)) next[to] = expanded;
    }
    expandedThreads = next;
  }
  return { state: { ...state, drafts, ...(expandedThreads === undefined ? {} : { expandedThreads }) }, changedDrafts: [...changedDrafts] };
}
