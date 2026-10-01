/**
 * Draws what `app/markdown-parse.ts` parsed. Every image goes through the
 * caller's `renderImage`, and every link through `isOpenableLink` and bb's
 * `UrlLink`, so nothing in a body is requested or opened behind the panel's
 * back.
 */
import { useState, type ReactNode } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";

import { cn } from "@/lib/utils";
import { isOpenableLink } from "./link";
import { imageOf, inlineTokens, parseMarkdown, type Block } from "./markdown-parse";

export interface MarkdownImage {
  url: string;
  alt: string;
}

interface RenderContext {
  /** Draws an image; the caller decides whether and how it may be fetched. */
  renderImage: (image: MarkdownImage) => ReactNode;
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineTokens(text).map((token, index) => {
        switch (token.kind) {
          case "text":
            return <span key={index}>{token.text}</span>;
          case "code":
            return (
              <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
                {token.text}
              </code>
            );
          case "bold":
            return (
              <strong key={index} className="font-semibold">
                {token.text}
              </strong>
            );
          case "link": {
            const label = token.image ? `[image: ${token.label}]` : <Inline text={token.label} />;
            // A comment's author picks the scheme; only http and https leave the panel.
            return isOpenableLink(token.url) ? (
              <UrlLink key={index} href={token.url} className="text-primary underline-offset-2 hover:underline">
                {label}
              </UrlLink>
            ) : (
              <span key={index} className="text-muted-foreground">
                {label}
              </span>
            );
          }
        }
      })}
    </>
  );
}

/** Collapsed unless the author wrote `open`, which is how GitHub shows it too. */
function DetailsBlock({ block, context }: { block: Extract<Block, { kind: "details" }>; context: RenderContext }) {
  const [expanded, setExpanded] = useState(block.open);
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        className="flex cursor-pointer items-start gap-1.5 text-left"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="text-muted-foreground">{expanded ? "▾" : "▸"}</span>
        <span>
          <Inline text={block.summary} />
        </span>
      </button>
      {expanded ? <div className="mt-2 space-y-2 pl-4">{renderBlocks(block.blocks, context)}</div> : null}
    </div>
  );
}

function renderBlocks(blocks: Block[], context: RenderContext): ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.kind) {
      case "heading":
        return (
          <p
            key={index}
            role="heading"
            aria-level={block.level}
            className={cn("font-semibold", block.level <= 2 ? "text-base" : "text-sm")}
          >
            <Inline text={block.text} />
          </p>
        );
      case "list":
        return (
          <div key={index} className="space-y-0.5">
            {block.items.map((item, itemIndex) => (
              <div key={itemIndex} className="flex gap-2" style={{ paddingLeft: item.depth * 16 }}>
                <span className="shrink-0 text-muted-foreground">{item.marker}</span>
                <span className="min-w-0 whitespace-pre-wrap break-words">
                  <Inline text={item.text} />
                </span>
              </div>
            ))}
          </div>
        );
      case "code":
        return (
          <pre key={index} className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
            {block.text}
          </pre>
        );
      case "quote":
        return (
          <div key={index} className="space-y-2 border-l-2 border-border pl-3 text-muted-foreground">
            {renderBlocks(block.blocks, context)}
          </div>
        );
      case "rule":
        return <hr key={index} className="border-border" />;
      case "details":
        return <DetailsBlock key={index} block={block} context={context} />;
      case "image":
        return <div key={index}>{context.renderImage({ url: block.url, alt: block.alt })}</div>;
      case "table":
        return (
          <div key={index} className="overflow-x-auto">
            <table className="w-full table-fixed border-collapse text-sm">
              <tbody>
                {[block.header, ...block.rows].map((cells, rowIndex) => (
                  <tr key={rowIndex} className="border-b border-border">
                    {cells.map((cell, cellIndex) => {
                      const image = imageOf(cell);
                      return (
                        <td
                          key={cellIndex}
                          className={cn("p-1.5 align-top", rowIndex === 0 && "font-semibold")}
                        >
                          {image !== null ? context.renderImage(image) : <Inline text={cell} />}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      default:
        return (
          <p key={index} className="whitespace-pre-wrap break-words">
            <Inline text={block.text} />
          </p>
        );
    }
  });
}

export function MarkdownBody({
  source,
  renderImage,
  className,
}: {
  source: string;
  renderImage: (image: MarkdownImage) => ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2 text-sm leading-relaxed", className)}>
      {renderBlocks(parseMarkdown(source), { renderImage })}
    </div>
  );
}
