// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Insets } from "../shared/placement";
import type { Viewport } from "./insets";

// jsdom resolves no env(), so the viewport is what each test says it is.
const viewport = vi.hoisted(() => ({ current: { insets: { top: 0, right: 0, bottom: 0, left: 0 }, height: 678 } as Viewport }));
vi.mock("./insets", async (original) => ({ ...(await original<typeof import("./insets")>()), useViewport: () => viewport.current }));

const DUO: Insets = { top: 0, right: 84, bottom: 34, left: 0 };

function setCompact(compact: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("max-width: 767px") ? compact : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

async function renderRail(options: Parameters<typeof renderSlot>[2] = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const [overlay] = app.appOverlays;
  if (overlay === undefined) throw new Error("no app overlay registered");
  return renderSlot(overlay, {}, options);
}

beforeEach(() => {
  viewport.current = { insets: DUO, height: 678 };
  setCompact(true);
});

afterEach(cleanup);

describe("the rail", () => {
  it("draws Back, New thread and More in the folded Duo's strip, below the camera", async () => {
    await renderRail();
    const rail = screen.getByTestId("duo-rail");
    expect(rail.dataset.side).toBe("right");
    expect(rail.style.top).toBe("175px");
    expect(rail.style.right).toBe("0px");
    expect(rail.style.width).toBe("84px");
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Back", "New thread", "More"]);
  });

  it("lets taps through everywhere but its buttons", async () => {
    await renderRail();
    expect(screen.getByTestId("duo-rail").style.pointerEvents).toBe("none");
    for (const button of screen.getAllByRole("button")) expect(button.className).toContain("pointer-events-auto");
  });

  it("starts at the camera clearance setting", async () => {
    await renderRail({ settings: { cameraClearance: 220 } });
    expect(screen.getByTestId("duo-rail").style.top).toBe("220px");
  });

  it("mirrors to the left strip", async () => {
    viewport.current = { insets: { top: 0, right: 0, bottom: 34, left: 84 }, height: 678 };
    await renderRail();
    const rail = screen.getByTestId("duo-rail");
    expect(rail.dataset.side).toBe("left");
    expect(rail.style.left).toBe("0px");
  });

  it("draws nothing on a wide layout", async () => {
    setCompact(false);
    await renderRail();
    expect(screen.queryByTestId("duo-rail")).toBeNull();
  });

  it("draws nothing on an ordinary iPhone", async () => {
    viewport.current = { insets: { top: 62, right: 0, bottom: 34, left: 0 }, height: 874 };
    await renderRail();
    expect(screen.queryByTestId("duo-rail")).toBeNull();
  });

  it("opens the new thread screen from New thread", async () => {
    const slot = await renderRail();
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(slot.inspection.navigateCalls).toEqual([expect.objectContaining({ method: "toCompose" })]);
  });

  it("goes back in the page's history from Back", async () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    await renderRail();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(back).toHaveBeenCalledOnce();
    back.mockRestore();
  });

  it("lists recent threads in More and opens the one picked", async () => {
    const thread = (id: string, displayTitle: string, latestAttentionAt: number) =>
      ({ id, displayTitle, isHidden: false, isArchived: false, isUnread: false, hasPendingInteraction: false, latestAttentionAt }) as never;
    const slot = await renderRail({
      context: { threadId: "current" },
      sidebarThreads: { threads: [thread("current", "On screen", 3), thread("t1", "Fix the flaky upload test", 2)] },
    });
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByText("On screen")).toBeNull();
    fireEvent.click(await screen.findByText("Fix the flaky upload test"));
    expect(slot.inspection.navigateCalls).toEqual([expect.objectContaining({ method: "toThread", threadId: "t1" })]);
  });
});
