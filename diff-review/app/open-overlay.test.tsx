// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";

import { parseReviewSubPath, reviewRoute, reviewSubPath } from "../shared/routes";
import { OpenReviewOverlay } from "./open-overlay";

afterEach(() => cleanup());

const asReceived = (subPath: string) => subPath.split("/").map(encodeURIComponent).join("/");

describe("opening a review from the command line", () => {
  const request = { threadId: "thr_1", target: { kind: "uncommitted" as const }, file: "src/dir/a.ts" };

  it("opens it in the window that shows its thread, at the file", async () => {
    const slot = renderSlot({ component: OpenReviewOverlay }, {}, { context: { threadId: "thr_1" } });
    await slot.behavior.emitRealtime("open-review", request);
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "reviews", options: { subPath: reviewSubPath(request) } }]);
    expect(parseReviewSubPath(asReceived(reviewSubPath(request)))).toEqual(request);
  });

  it("leaves a window showing another thread, or none, alone", async () => {
    const slot = renderSlot({ component: OpenReviewOverlay }, {}, { context: { threadId: "thr_2" } });
    await slot.behavior.emitRealtime("open-review", request);
    await slot.behavior.emitRealtime("open-review", { threadId: "thr_2", target: { kind: "nonsense" } });
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("prints the page's route with each segment encoded as bb's router keeps them", () => {
    expect(reviewRoute("diff-review", { threadId: "thr_1", target: { kind: "uncommitted" } })).toBe(
      `/plugins/diff-review/reviews/thr_1/${encodeURIComponent(encodeURIComponent(JSON.stringify({ kind: "uncommitted" })))}`,
    );
  });
});
