/**
 * The Reviews page: every review with comment threads, across projects, newest first, in the page's
 * own sidebar, and the one picked shown in full beside it (the same view as the thread's Review tab).
 * Its sidebar entry counts the open comment threads, and the window title names the open review.
 */
import { useBbNavigate, type ExperimentalBadge, type ExperimentalPageTitle, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

import type { ReviewSummary } from "../shared/types";
import { ago, targetLabel } from "./labels";
import { ReviewBody } from "./review-panel";
import { REVIEWS_PATH } from "../shared/routes";
import { isReview, parseReviewSubPath, reviewSubPath, useReviewCounts, useReviews } from "./reviews";

export { REVIEWS_PATH };

function countText(review: ReviewSummary): string {
  return review.openCount === 0 ? `${review.totalCount} closed` : `${review.openCount} open of ${review.totalCount}`;
}

function ReviewList({ subPath, compact }: { subPath: string; compact: boolean }) {
  const navigate = useBbNavigate();
  const { data, error } = useReviews();
  const selected = parseReviewSubPath(subPath);
  if (data === undefined) return <p className="p-3 text-xs text-muted-foreground">{error === null ? "Loading the reviews…" : `Could not load the reviews: ${error}`}</p>;
  if (data.length === 0) return <p className="p-3 text-xs text-muted-foreground">No reviews yet. Comment on a thread's changes in its Review tab and it shows here.</p>;
  return (
    <ul className={compact ? "flex flex-col gap-0.5 p-2" : "flex flex-col gap-1 p-3"} aria-label="Reviews">
      {data.map((review) => {
        const current = isReview(review, selected);
        return (
          <li key={review.sessionId}>
            <button
              type="button"
              aria-current={current ? "page" : undefined}
              className={`flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-state-hover ${current ? "bg-state-active" : ""}`}
              onClick={() => navigate.toPluginPanel(REVIEWS_PATH, { subPath: reviewSubPath(review) })}
            >
              <span className="w-full truncate text-sm">{review.threadTitle}</span>
              <span className="w-full truncate text-xs text-muted-foreground">
                {targetLabel(review.target)} · {countText(review)} · {ago(review.updatedAt)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function ReviewsSidebar({ subPath }: PluginNavPanelProps) {
  return <ReviewList subPath={subPath} compact />;
}

export function ReviewsPage({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const { data } = useReviews();
  const selected = parseReviewSubPath(subPath);
  if (selected === null) {
    return (
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col">
        <h2 className="px-3 pt-3 text-sm font-medium">Reviews</h2>
        <ReviewList subPath={subPath} compact={false} />
      </div>
    );
  }
  const review = data?.find((row) => isReview(row, selected)) ?? null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <span className="min-w-0 truncate">{review?.threadTitle ?? "Review"}</span>
        <Button type="button" variant="ghost" size="sm" className="ml-auto h-6 gap-1 px-1.5 text-xs" onClick={() => navigate.toThread(selected.threadId)}>
          <Icon name="ArrowUpRight" className="size-3.5" />
          Open thread
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <ReviewBody
          key={subPath}
          threadId={selected.threadId}
          environmentId={review?.environmentId ?? null}
          params={{ target: selected.target }}
          visible
          initialFile={selected.file}
        />
      </div>
    </div>
  );
}

/** The window title: the open review's thread and view. */
export function useReviewsPageTitle({ subPath }: PluginNavPanelProps): ExperimentalPageTitle | null {
  const { data } = useReviews();
  const selected = parseReviewSubPath(subPath);
  const review = data?.find((row) => isReview(row, selected));
  return review === undefined ? null : { title: `${review.threadTitle} · ${targetLabel(review.target)}` };
}

/** The sidebar entry's badge: how many comment threads are open across reviews. */
export function useReviewsBadge(): ExperimentalBadge | null {
  const { data } = useReviewCounts(null);
  if (data === undefined || data.open === 0) return null;
  return { count: data.open, label: `${data.open} open review comment${data.open === 1 ? "" : "s"}` };
}
