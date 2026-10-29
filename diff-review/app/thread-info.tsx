/**
 * A row in the thread's Info tab: how many review comment threads its workspace has open, with a
 * button that opens the Review tab. Nothing for a workspace with none.
 */
import { experimental_DetailRow as DetailRow, experimental_useAppPanel, type ExperimentalThreadInfoProps } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";

import { useReviewCounts } from "./reviews";
import { openReviewTab } from "./tab";

export function ReviewInfoRow({ environment }: ExperimentalThreadInfoProps) {
  const panel = experimental_useAppPanel();
  const { data } = useReviewCounts(environment?.id ?? "none");
  if (environment === null || data === undefined || data.total === 0) return null;
  return (
    <DetailRow label="Review" icon="FileDiff">
      <span className="flex items-center gap-2">
        <span>{data.open === 0 ? `${data.total} comment thread${data.total === 1 ? "" : "s"}, all closed` : `${data.open} open of ${data.total} comment threads`}</span>
        <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => openReviewTab(panel)}>
          Open
        </Button>
      </span>
    </DetailRow>
  );
}
