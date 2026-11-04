/**
 * File references, linked the way bb links them in chat. bb's `Markdown` turns a Markdown link to a
 * workspace path, and an inline-code path such as `src/a.ts`, `src/a.ts:42` or `src/a.ts:40-60`, into a
 * link that opens the file in bb's preview at that line or range. It does so only where it knows the
 * workspace: a chat message knows its thread's, but a plugin's card or tab does not, so there the same
 * text stayed plain. `experimental_document` hands it the workspace (bb 0.48.1's `PluginMarkdown` resolves
 * relative links against the document's folder and opens them with `experimental_openFilePreview`).
 *
 * A card's `files` are drawn with `experimental_FileLink`, which takes the line or range as `location`.
 */
import {
  experimental_FileLink as FileLink,
  Markdown,
  type ExperimentalFileLocation,
  type MarkdownProps,
} from "@get-bb/plugin-sdk/app";
import { Fragment } from "react";

import type { Workspace } from "../shared/types";

/**
 * The document the Markdown is resolved as: a file at the workspace's root, so relative paths resolve
 * from the root. Only its folder is used; the file need not exist.
 */
const DOCUMENT_NAME = "learning-exercise.md";

export function markdownDocument(workspace: Workspace | null | undefined): MarkdownProps["experimental_document"] {
  if (workspace === null || workspace === undefined) return undefined;
  return {
    threadId: workspace.threadId,
    rootPath: workspace.rootPath,
    target: { kind: "workspace", environmentId: workspace.environmentId, path: DOCUMENT_NAME },
  };
}

/** Markdown whose file references open in `workspace`; with none, bb's own routing (a chat message's). */
export function FileMarkdown(props: { content: string; workspace: Workspace | null | undefined; className?: string }) {
  const document = markdownDocument(props.workspace);
  return <Markdown content={props.content} className={props.className} {...(document === undefined ? {} : { experimental_document: document })} />;
}

function lineNumber(text: string | undefined): number | null {
  if (text === undefined) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function rangeOf(start: number | null, end: number | null): ExperimentalFileLocation | null {
  if (start === null) return null;
  if (end === null || end === start) return { kind: "line", line: start, column: null };
  return end > start ? { kind: "range", startLine: start, endLine: end } : null;
}

/**
 * Splits a reference into its path and the line or range it points at, in the forms bb's chat links
 * read: `path:42`, `path:42:7` (the column is dropped), `path:40-60`, `path#L42`, `path#L40-L60`.
 */
export function parseFileRef(ref: string): { path: string; location: ExperimentalFileLocation | null } {
  const text = ref.trim();
  const hash = /#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/u.exec(text);
  const colon = hash === null ? /:(\d+)(?:-(\d+)|:\d+)?$/u.exec(text) : null;
  const match = hash ?? colon;
  if (match === null) return { path: text, location: null };
  const location = rangeOf(lineNumber(match[1]), lineNumber(match[2]));
  return location === null ? { path: text, location: null } : { path: text.slice(0, match.index), location };
}

/** One of a card's `files`, as a link that opens it (at its line or range) in the session's workspace. */
export function FileRef(props: { reference: string; environmentId: string | null }) {
  const { path, location } = parseFileRef(props.reference);
  if (props.environmentId === null || path === "") return <code>{props.reference}</code>;
  return (
    <FileLink target={{ kind: "workspace", environmentId: props.environmentId, path }} location={location} className="font-mono underline-offset-2 hover:underline">
      {props.reference}
    </FileLink>
  );
}

/**
 * Whether bb would link this inline code in a chat message: no spaces, not a URL, and either a path
 * that starts with `./` or `../`, a name with an extension, or a line suffix. Absolute paths are left
 * as code here, since a workspace link takes a path inside the workspace.
 */
export function looksLikeFileRef(text: string): boolean {
  if (text === "" || /\s/u.test(text) || text.includes("://") || text.startsWith("/") || text.startsWith("~")) return false;
  const { path, location } = parseFileRef(text);
  if (path === "" || path.endsWith("/")) return false;
  return location !== null || /^\.{1,2}\//u.test(path) || /\.[\p{L}\p{N}_-]+$/u.test(path);
}

/**
 * Plain text (an offer's or a session's topic, which quote commit subjects and titles as they are) whose
 * backticked paths become file links. It is not Markdown on purpose: a subject's `*` or `<` stays text.
 */
export function TextWithFileRefs(props: { text: string; environmentId: string | null }) {
  const parts = props.text.split(/`([^`\n]+)`/u);
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index % 2 === 0 ? part : looksLikeFileRef(part) ? <FileRef reference={part} environmentId={props.environmentId} /> : <code>{part}</code>}
        </Fragment>
      ))}
    </>
  );
}
