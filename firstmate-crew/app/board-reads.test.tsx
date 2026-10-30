// @vitest-environment jsdom
/**
 * How the FirstMate tab reads the fleet: through bb's live reads, again when the server invalidates the
 * `fleet` tag, and not at all while the tab cannot be seen.
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rpcContract } from "../shared/contract";
import type { Fleet } from "../shared/types";
import { Panel } from "./panel";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const FLEET: Fleet = {
  home: "/h",
  homeReady: true,
  mate: null,
  mateMissing: false,
  cards: [],
  suggestions: [],
  charter: { edited: false, outdated: false },
  watches: [],
};

function renderPanel(tabVisible: boolean) {
  let reads = 0;
  const view = renderSlot(
    { component: Panel },
    { threadId: "thr_other" },
    {
      experimental_rpcContract: rpcContract,
      tabVisible,
      rpc: {
        "fleet.load": () => {
          reads += 1;
          return FLEET;
        },
      },
    },
  );
  return { view, reads: () => reads };
}

describe("the FirstMate tab's reads", () => {
  it("reads the fleet when shown, and again when the server invalidates it", async () => {
    const { view, reads } = renderPanel(true);
    await waitFor(() => expect(screen.getByText("No first mate aboard")).toBeTruthy());
    expect(reads()).toBe(1);

    await view.experimental_invalidateRpc(["fleet"]);
    await waitFor(() => expect(reads()).toBe(2));
  });

  it("reads nothing while the tab is hidden", async () => {
    const { reads } = renderPanel(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads()).toBe(0);
    expect(screen.getByText("Loading…")).toBeTruthy();
  });
});
