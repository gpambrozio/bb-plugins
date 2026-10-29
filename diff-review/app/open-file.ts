/**
 * Which version of a file the header's Open button shows, in bb's own read-only preview: the working
 * copy where the view compares against it, the commit's version in a commit view, `HEAD` for the
 * branch's committed changes, and for a deleted file the version before it went (`HEAD`, or the
 * merge base). Null when bb cannot open that version (a file a commit deleted: bb takes only `HEAD`
 * or a commit, not a parent).
 */
import type { DiffFile, Target } from "../shared/types";

/** bb takes `HEAD` or a 4–40 character commit SHA as a preview's ref. */
const REF = /^(HEAD|[0-9a-f]{4,40})$/i;

export function fileRef(target: Target, file: Pick<DiffFile, "changeKind">, mergeBaseRef: string | null, headRef: string | null = null): { ref: string | null } | null {
  const deleted = file.changeKind === "deleted";
  const base = mergeBaseRef !== null && REF.test(mergeBaseRef) ? mergeBaseRef : null;
  switch (target.kind) {
    case "uncommitted":
      return { ref: deleted ? "HEAD" : null };
    case "commit":
      return deleted || !REF.test(target.sha) ? null : { ref: target.sha };
    case "branch":
      return deleted ? (base === null ? null : { ref: base }) : { ref: "HEAD" };
    case "all":
      return deleted ? (base === null ? null : { ref: base }) : { ref: null };
    case "staged":
      // The index has no preview of its own; the working copy is the nearest, HEAD for a deletion.
      return { ref: deleted ? "HEAD" : null };
    case "unstaged":
      return deleted ? null : { ref: null };
    case "files":
      return { ref: null };
    case "range": {
      const head = headRef !== null && REF.test(headRef) ? headRef : null;
      if (deleted) return base === null ? null : { ref: base };
      return head === null ? null : { ref: head };
    }
  }
}
