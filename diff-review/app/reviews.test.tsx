// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReviewSummary } from "../shared/types";
import { ReviewsPage, ReviewsSidebar, useReviewsBadge, useReviewsPageTitle } from "./reviews-page";
import { parseReviewSubPath, reviewSubPath } from "./reviews";
import { ReviewInfoRow } from "./thread-info";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock("@pierre/diffs/react", () => ({ PatchDiff: () => <div data-testid="patch" /> }));

afterEach(() => cleanup());

const REVIEW: ReviewSummary = {
  sessionId: "ses_1",
  environmentId: "env_1",
  target: { kind: "branch", base: "feature/base" },
  openCount: 2,
  totalCount: 3,
  updatedAt: Date.now(),
  threadId: "thr_1",
  threadTitle: "Add the parser",
  projectId: "proj_1",
};

/** What bb hands the page: each segment of the subPath percent-encoded. */
const asReceived = (subPath: string) => subPath.split("/").map(encodeURIComponent).join("/");

describe("the Reviews page's addresses", () => {
  it("round-trips a review whose view names a branch with a slash", () => {
    expect(parseReviewSubPath(asReceived(reviewSubPath(REVIEW)))).toEqual({ threadId: "thr_1", target: { kind: "branch", base: "feature/base" }, file: null });
    expect(parseReviewSubPath("")).toBeNull();
    expect(parseReviewSubPath("thr_1/not-json")).toBeNull();
  });
});

describe("the Reviews page", () => {
  it("lists the reviews in its sidebar and opens one on the page", async () => {
    const slot = renderSlot({ component: ReviewsSidebar }, { subPath: "" }, { rpc: { listReviews: () => ({ reviews: [REVIEW] }) } });
    fireEvent.click(await screen.findByRole("button", { name: /Add the parser/ }));
    expect(screen.getByText(/Committed since feature\/base · 2 open of 3/)).toBeTruthy();
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "reviews", options: { subPath: reviewSubPath(REVIEW) } }]);
  });

  it("says so when there are none", async () => {
    renderSlot({ component: ReviewsPage }, { subPath: "" }, { rpc: { listReviews: () => ({ reviews: [] }) } });
    expect(await screen.findByText(/No reviews yet/)).toBeTruthy();
  });

  it("says how many reviews no thread can open, and deletes them only once confirmed", async () => {
    const orphan = (sessionId: string, openCount: number, totalCount: number) => ({ sessionId, environmentId: `env_${sessionId}`, target: { kind: "branch" as const, base: "origin/main" }, openCount, totalCount, updatedAt: 1 });
    let orphans = [orphan("ses_a", 4, 4), orphan("ses_b", 2, 2), orphan("ses_c", 1, 2)];
    const slot = renderSlot(
      { component: ReviewsPage },
      { subPath: "" },
      {
        rpc: {
          listReviews: () => ({ reviews: [REVIEW] }),
          orphanReviews: () => ({ reviews: orphans }),
          deleteOrphanReviews: () => {
            orphans = [];
            return { deleted: 3, deletedThreads: 8 };
          },
        },
      },
    );
    expect(await screen.findByText(/Not listed: 3 reviews with 8 comment threads \(7 open\), in workspaces that are gone/)).toBeTruthy();
    const deletes = () => slot.inspection.rpcCalls.filter((call) => call.method === "deleteOrphanReviews");
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    expect(await screen.findByText(/This deletes 3 reviews with 8 comment threads \(7 open\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deletes()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete reviews" }));
    await waitFor(() => expect(deletes().map((call) => call.input)).toEqual([{ sessionIds: ["ses_a", "ses_b", "ses_c"] }]));
    // The server tells the page; the notice goes once none are left.
    await slot.behavior.emitRealtime("reviews", { kind: "threads", sessionId: "ses_a" });
    await waitFor(() => expect(screen.queryByText(/Not listed/)).toBeNull());
  });

  it("shows the review a subPath names, as the thread's Review tab does", async () => {
    const slot = renderSlot(
      { component: ReviewsPage },
      { subPath: asReceived(reviewSubPath(REVIEW)) },
      { rpc: { listReviews: () => ({ reviews: [REVIEW] }), getReview: () => ({ ok: false, message: "This thread's workspace is gone." }) } },
    );
    expect(await screen.findByText("This thread's workspace is gone.")).toBeTruthy();
    expect(slot.inspection.rpcCalls.find((call) => call.method === "getReview")!.input).toMatchObject({ threadId: "thr_1", target: { kind: "branch", base: "feature/base" } });
    fireEvent.click(screen.getByRole("button", { name: "Open thread" }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_1" });
  });
});

function HookProbe({ subPath }: { subPath: string }) {
  const title = useReviewsPageTitle({ subPath });
  const badge = useReviewsBadge();
  return <output>{JSON.stringify({ title, badge })}</output>;
}

describe("the page's title and badge", () => {
  it("name the open review and count the open comment threads", async () => {
    const slot = renderSlot(
      { component: HookProbe },
      { subPath: asReceived(reviewSubPath(REVIEW)) },
      { rpc: { listReviews: () => ({ reviews: [REVIEW] }), reviewCounts: () => ({ open: 2, total: 3 }) } },
    );
    await waitFor(() =>
      expect(JSON.parse(screen.getByRole("status").textContent!)).toEqual({
        title: { title: "Add the parser · Committed since feature/base" },
        badge: { count: 2, label: "2 open review comments" },
      }),
    );
    expect(slot.inspection.rpcCalls.find((call) => call.method === "reviewCounts")!.input).toEqual({});
  });

  it("show no badge when nothing is open", async () => {
    renderSlot({ component: HookProbe }, { subPath: "" }, { rpc: { listReviews: () => ({ reviews: [] }), reviewCounts: () => ({ open: 0, total: 4 }) } });
    await waitFor(() => expect(JSON.parse(screen.getByRole("status").textContent!)).toEqual({ title: null, badge: null }));
  });
});

describe("the thread's Info row", () => {
  it("counts the workspace's comment threads and opens the Review tab", async () => {
    const slot = renderSlot(
      { component: ReviewInfoRow },
      { threadId: "thr_1", projectId: "proj_1", environment: { id: "env_1" } },
      { rpc: { reviewCounts: () => ({ open: 1, total: 2 }) }, experimental_panel: { openTab: () => true } },
    );
    expect(await screen.findByText("1 open of 2 comment threads")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(slot.inspection.experimental_panelCalls).toEqual([{ method: "openTab", options: { tab: { id: "review", context: { kind: "thread" }, availability: "action" } } }]);
    expect(slot.inspection.rpcCalls[0]!.input).toEqual({ environmentId: "env_1" });
  });

  it("reads the counts again when the thread's workspace changes, dropping the old ones", async () => {
    const counts: Record<string, { open: number; total: number }> = { none: { open: 0, total: 0 }, env_1: { open: 1, total: 2 }, env_2: { open: 3, total: 3 } };
    const slot = renderSlot(
      { component: ReviewInfoRow },
      { threadId: "thr_1", projectId: "proj_1", environment: null },
      { rpc: { reviewCounts: (input: unknown) => counts[(input as { environmentId?: string }).environmentId ?? "none"]! } },
    );
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    // The workspace comes ready: no review signal arrives, the row still reads its counts.
    slot.rerender(<ReviewInfoRow threadId="thr_1" projectId="proj_1" environment={{ id: "env_1" } as never} />);
    expect(await screen.findByText("1 open of 2 comment threads")).toBeTruthy();
    slot.rerender(<ReviewInfoRow threadId="thr_1" projectId="proj_1" environment={{ id: "env_2" } as never} />);
    expect(screen.queryByText("1 open of 2 comment threads")).toBeNull();
    expect(await screen.findByText("3 open of 3 comment threads")).toBeTruthy();
    expect(slot.inspection.rpcCalls.map((call) => call.input)).toEqual([{ environmentId: "none" }, { environmentId: "env_1" }, { environmentId: "env_2" }]);
  });

  it("is absent for a workspace without review comments", async () => {
    const { container } = renderSlot(
      { component: ReviewInfoRow },
      { threadId: "thr_1", projectId: "proj_1", environment: { id: "env_1" } },
      { rpc: { reviewCounts: () => ({ open: 0, total: 0 }) } },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(container.textContent).toBe("");
  });
});

