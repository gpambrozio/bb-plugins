/**
 * The walkthrough tab: a thread panel tab (action tab, opened by "Read walkthrough") showing one
 * orientation's contents, chapters, notes and the code listings the plugin captured, each with its verify
 * badge. `params` is unknown and parsed with zod; a bad one, or an orientation that is gone, reads
 * "This walkthrough is no longer available."
 *
 * The tab scrolls its own container (`scrollWithin`, never `scrollIntoView`). Notes render through
 * `FileMarkdown`; a note that mentions `Listing N` gets a small row of buttons under it that scroll to
 * those listings (splitting the text around mentions before Markdown would break lists and emphasis).
 * Listing paths link into the orientation's workspace, or are plain code when it is gone.
 */
import { experimental_FileLink as FileLink, experimental_useTabVisible, type ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import type { OrientationBlock } from "../shared/orientation";
import { workspacePath } from "../shared/workspace-path";
import { errorText, useLearningRpc, useOrientationDocument } from "./data";
import { ExportDialog } from "./export-dialog";
import { FileMarkdown } from "./file-refs";
import { scrollWithin } from "./scroll-within";

const ParamsSchema = z.object({ orientationId: z.string().min(1) });

type Listing = Extract<OrientationBlock, { kind: "listing" }>;

/** The line range a listing's link opens: where it moved to, else where it was captured. */
export function listingRange(listing: Listing): { start: number; end: number } {
  const { check } = listing;
  if (check?.state === "moved" && check.startLine !== null && check.endLine !== null) return { start: check.startLine, end: check.endLine };
  return { start: listing.startLine, end: listing.endLine };
}

/** The badge text for a listing's check; null when it was never checked. */
export function badgeText(listing: Listing): string | null {
  const { check } = listing;
  if (check === null) return null;
  if (check.state === "current") return "current";
  if (check.state === "missing") return "missing";
  if (check.state === "moved") {
    const range = listingRange(listing);
    return `moved to ${range.start}–${range.end}`;
  }
  return listing.ref === null ? "changed since capture" : `changed since ${listing.ref.slice(0, 7)}`;
}

function badgeClass(listing: Listing): string {
  const state = listing.check?.state;
  if (state === "current") return "text-success";
  if (state === "moved") return "text-muted-foreground";
  return "text-warning-text";
}

/**
 * What Verify's toast says. `checked: 0` with listings to check means no checkout was reachable (or every
 * read failed): saying "none have drifted" then would claim a check that did not happen.
 */
export function verifyMessage(result: { checked: number; drift: readonly string[] }, listings: number): string {
  const { checked, drift } = result;
  if (checked === 0) return listings === 0 ? "This orientation has no listings to check." : "Could not reach this project's files to check the listings.";
  const counted = `Checked ${checked} ${checked === 1 ? "listing" : "listings"}`;
  return drift.length === 0 ? `${counted}; none have drifted.` : `${counted}; ${drift.length} drifted: ${drift.join(", ")}`;
}

/** The listing numbers a note mentions, in order, once each. */
export function mentionedListings(markdown: string): number[] {
  const numbers = [...markdown.matchAll(/\bListing (\d+)\b/gu)].map((match) => Number(match[1]));
  return [...new Set(numbers)];
}

function ListingView(props: { listing: Listing; environmentId: string | null; elementId: string }) {
  const { listing, environmentId } = props;
  const range = listingRange(listing);
  const path = workspacePath(listing.path);
  const label = `${listing.path}:${range.start}–${range.end}`;
  const badge = badgeText(listing);
  return (
    <section id={props.elementId} className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">{`Listing ${listing.number}: ${listing.caption}`}</h3>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {environmentId === null || path === null ? (
          <code>{label}</code>
        ) : (
          <FileLink
            target={{ kind: "workspace", environmentId, path }}
            location={{ kind: "range", startLine: range.start, endLine: range.end }}
            className="font-mono underline-offset-2 hover:underline"
          >
            {label}
          </FileLink>
        )}
        {badge !== null && <span className={badgeClass(listing)}>{badge}</span>}
      </div>
      <pre className="overflow-x-auto rounded-md border border-border bg-card p-2 text-xs">
        <code>{listing.text}</code>
      </pre>
    </section>
  );
}

export function OrientationTab(props: ExperimentalThreadTabProps & { params: unknown }) {
  const parsed = ParamsSchema.safeParse(props.params);
  if (!parsed.success) return <p className="text-sm text-muted-foreground">This walkthrough is no longer available.</p>;
  return <Walkthrough orientationId={parsed.data.orientationId} />;
}

function Walkthrough(props: { orientationId: string }) {
  const { orientationId } = props;
  // Not read while the tab is hidden: a read can check the listings, and a refetch on every change would.
  const query = useOrientationDocument(orientationId, experimental_useTabVisible());
  const rpc = useLearningRpc();
  const scroller = useRef<HTMLDivElement | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const data = query.data;
  if (data === undefined) {
    return query.error === null || query.error === undefined ? null : <p className="text-sm text-muted-foreground">This walkthrough is no longer available.</p>;
  }
  const { orientation, blocks } = data;
  const environmentId = orientation.workspace?.environmentId ?? null;
  const chapters = blocks.flatMap((block) => (block.kind === "chapter" ? [block] : []));

  function scrollTo(elementId: string) {
    const root = scroller.current;
    const target = document.getElementById(elementId);
    if (root !== null && target !== null) scrollWithin(root, target, "start");
  }

  async function verify() {
    setVerifying(true);
    try {
      toast(verifyMessage(await rpc.call("verifyOrientation", { orientationId }), orientation.listings));
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div ref={scroller} data-testid="walkthrough-scroll" className="flex h-full flex-col gap-3 overflow-y-auto">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium">{orientation.title}</h2>
        <Button type="button" size="sm" variant="ghost" disabled={verifying} onClick={() => void verify()}>
          Verify
        </Button>
        <Button type="button" size="sm" variant="ghost" aria-expanded={exportOpen} onClick={() => setExportOpen((open) => !open)}>
          Export to repo…
        </Button>
      </div>
      {exportOpen && <ExportDialog orientationId={orientationId} onDone={() => setExportOpen(false)} />}
      {chapters.length > 0 && (
        <nav className="flex flex-col gap-0.5">
          <h3 className="text-xs font-medium text-muted-foreground">Contents</h3>
          {chapters.map((chapter) => (
            <Button key={chapter.ordinal} type="button" size="sm" variant="ghost" className="justify-start" onClick={() => scrollTo(`chapter-${chapter.ordinal}`)}>
              {chapter.title}
            </Button>
          ))}
        </nav>
      )}
      {blocks.map((block) => {
        if (block.kind === "chapter") {
          return (
            <h2 key={block.ordinal} id={`chapter-${block.ordinal}`} className="pt-2 text-base font-medium">
              {block.title}
            </h2>
          );
        }
        if (block.kind === "note") {
          const mentions = mentionedListings(block.markdown);
          return (
            <div key={block.ordinal} className="flex flex-col gap-1">
              <FileMarkdown content={block.markdown} workspace={orientation.workspace} />
              {mentions.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  Listings in this note:
                  {mentions.map((number) => (
                    <Button key={number} type="button" size="sm" variant="ghost" onClick={() => scrollTo(`listing-${number}`)}>
                      {number}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          );
        }
        return <ListingView key={block.ordinal} listing={block} environmentId={environmentId} elementId={`listing-${block.number}`} />;
      })}
    </div>
  );
}
