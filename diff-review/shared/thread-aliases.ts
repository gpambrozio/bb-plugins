/**
 * A comment thread folded into another (two local copies of one GitHub thread, see the store's
 * `foldThread`) leaves an alias: its old id names the thread kept. What a tab keeps by thread id (a
 * reply being typed, a fold) follows the alias, on the server and in every open tab, so neither a
 * save made before the fold nor a window's own copy can bring the old id back.
 *
 * Plain functions over plain data: the app imports this at run time, so it must not import the SDK.
 */
import { DRAFT_MAX_CHARS, type Draft } from "./types";

/** Old thread id → the id of the thread it was folded into. */
export type ThreadAliases = Readonly<Record<string, string>>;

const REPLY = "reply:";

/** How two reply texts are joined in one editor; `withoutSent` takes one of them out again. */
const JOIN = "\n\n";

/**
 * Two reply drafts for one thread, `kept` already on it and `moved` from its folded copy: an empty
 * one gives way to the other, the same text is kept once, and two different texts are both kept in
 * full, one after the other in the reply's editor (nothing is posted until the user presses Reply,
 * and the editor asks for a text over the comment limit to be shortened first). Null when the joined
 * text would not fit even a draft (`DRAFT_MAX_CHARS`): a draft that was itself joined meeting another,
 * which a fold of two copies cannot make; the caller then leaves `moved` where it was.
 */
export function mergeReplyDrafts(kept: Draft, moved: Draft): Draft | null {
  if (moved.body.trim() === "" || moved.body.trim() === kept.body.trim()) return kept;
  if (kept.body.trim() === "") return { ...kept, body: moved.body };
  const body = `${kept.body}${JOIN}${moved.body}`;
  return body.length > DRAFT_MAX_CHARS ? null : { ...kept, body };
}

/**
 * The draft text left once `sent` was posted from it: none when it was all of it, the other text when
 * it was one of two joined (`mergeReplyDrafts`), and `body` as it is when it was neither.
 */
export function withoutSent(body: string, sent: string): string | null {
  if (body.trim() === sent.trim()) return null;
  if (body.startsWith(`${sent}${JOIN}`)) return body.slice(sent.length + JOIN.length);
  if (body.endsWith(`${JOIN}${sent}`)) return body.slice(0, body.length - sent.length - JOIN.length);
  return body;
}

/** The key `key` names once its thread's alias is followed: `reply:<kept>` for `reply:<folded>`. */
export function aliasedKey(key: string, aliases: ThreadAliases): string | undefined {
  if (!key.startsWith(REPLY)) return undefined;
  const id = key.slice(REPLY.length);
  return Object.hasOwn(aliases, id) ? `${REPLY}${aliases[id]}` : undefined;
}

/**
 * `state` with each reply draft and thread fold kept under an alias moved to the thread it names
 * (`mergeReplyDrafts` when that thread has a draft too; a fold already there wins), and the keys of
 * the drafts that changed; null when nothing moved. Drafts keep their order.
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
    const merged = there === undefined ? draft : mergeReplyDrafts(there, draft);
    if (merged === null) {
      // Too long to join: it stays under the folded id, as stored, rather than lose any of it.
      drafts[key] = draft;
      continue;
    }
    drafts[to] = merged;
    changedDrafts.add(to);
  }

  if (changedDrafts.size === 0 && folds.length === 0) return null;
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
