// @vitest-environment jsdom
/**
 * The first-run guide in the app: the offer's toast and its three answers, the board opened in the first
 * mate's thread once it is on screen, and the pure helpers.
 */
import { act, cleanup, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardOpener, INTRO_TOAST_ID, INTRO_TOAST_TITLE, IntroOverlay, looksLikeHome, showFirstMate } from "./intro";
import { createIntroStore, introStore } from "./intro-store";
import { findLocalHostId } from "./local-host";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn(), dismiss: vi.fn() }) }));

const toastMock = toast as unknown as ReturnType<typeof vi.fn> & { dismiss: ReturnType<typeof vi.fn> };

/** The options of the newest offer shown. */
function lastOffer() {
  const calls = toastMock.mock.calls.filter(([title]) => title === INTRO_TOAST_TITLE);
  const options = calls.at(-1)?.[1] as
    | { id: string; action: { label: string; onClick: () => void }; cancel: { label: string; onClick: () => void } }
    | undefined;
  if (options === undefined) throw new Error("no offer was shown");
  return options;
}

beforeEach(() => {
  introStore.close();
  introStore.showBoardFor(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the offer's toast", () => {
  it("shows while the server offers the guide, and Start opens the setup", async () => {
    renderSlot({ component: IntroOverlay }, {}, { rpc: { "intro.status": () => ({ offer: true, homeDirectory: "~/FirstMate" }) } });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(INTRO_TOAST_TITLE, expect.anything()));
    const offer = lastOffer();
    expect(offer.id).toBe(INTRO_TOAST_ID);
    expect([offer.action.label, offer.cancel.label]).toEqual(["Start", "Later"]);

    act(() => offer.action.onClick());
    expect(introStore.get().open).toBe(true);
    // The dialog is up: the toast steps aside.
    await waitFor(() => expect(toastMock.dismiss).toHaveBeenCalledWith(INTRO_TOAST_ID));
  });

  it("shows nothing when the server does not offer it", async () => {
    const view = renderSlot({ component: IntroOverlay }, {}, { rpc: { "intro.status": () => ({ offer: false, homeDirectory: "/h" }) } });
    await waitFor(() => expect(view.rpcCalls.some((call) => call.method === "intro.status")).toBe(true));
    expect(toastMock.mock.calls.filter(([title]) => title === INTRO_TOAST_TITLE)).toEqual([]);
  });

  it("Later puts it away in this window only, without telling the server", async () => {
    const store = createIntroStore();
    store.snooze();
    expect(store.get()).toEqual({ open: false, snoozed: true, boardFor: null });
    const view = renderSlot({ component: IntroOverlay }, {}, { rpc: { "intro.status": () => ({ offer: true, homeDirectory: "~/FirstMate" }) } });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(INTRO_TOAST_TITLE, expect.anything()));
    act(() => lastOffer().cancel.onClick());
    expect(introStore.get().snoozed).toBe(true);
    await waitFor(() => expect(toastMock.dismiss).toHaveBeenCalledWith(INTRO_TOAST_ID));
    expect(view.rpcCalls.map((call) => call.method)).not.toContain("intro.dismiss");
  });
});

describe("the guide's end", () => {
  it("opens the first mate's thread in place of the current view, never as a split beside it", () => {
    introStore.open();
    const toThread = vi.fn();
    showFirstMate({ toThread }, "thr_mate");
    // A split would keep the view the guide started from as a pane of its own: an empty New thread screen.
    expect(toThread.mock.calls).toEqual([["thr_mate"]]);
    expect(introStore.get()).toMatchObject({ open: false, boardFor: "thr_mate" });
  });
});

describe("the board opener", () => {
  it("opens the FirstMate tab in the first mate's thread once its composer shows, and only there", async () => {
    const openTab = vi.fn(() => true);
    introStore.showBoardFor("thr_mate");

    const elsewhere = renderSlot(
      { component: BoardOpener },
      {},
      { composer: { scope: { kind: "thread", threadId: "thr_other" } }, experimental_panel: { openTab } },
    );
    expect(openTab).not.toHaveBeenCalled();
    elsewhere.lifecycle.unmount();

    renderSlot({ component: BoardOpener }, {}, { composer: { scope: { kind: "thread", threadId: "thr_mate" } }, experimental_panel: { openTab } });
    await waitFor(() =>
      expect(openTab).toHaveBeenCalledWith({ tab: { id: "firstmate", context: { kind: "thread" }, availability: "action" } }),
    );
    expect(introStore.get().boardFor).toBeNull();
  });
});

describe("looksLikeHome", () => {
  it("takes an absolute path or one under ~, nothing else", () => {
    expect(looksLikeHome("~/FirstMate")).toBe(true);
    expect(looksLikeHome(" /Users/me/fm ")).toBe(true);
    expect(looksLikeHome("~")).toBe(true);
    expect(looksLikeHome("FirstMate")).toBe(false);
    expect(looksLikeHome("~me/fm")).toBe(false);
    expect(looksLikeHome("")).toBe(false);
  });
});

describe("findLocalHostId", () => {
  it("picks the connected host daemon serving this window's bb, and none when nothing answers", async () => {
    const answers: Record<number, unknown> = {
      1: { hostId: "host_other", connected: true, serverUrl: "http://other:1" },
      2: { hostId: "host_ours", connected: true, serverUrl: "http://127.0.0.1:38886/" },
      3: { hostId: "host_off", connected: false, serverUrl: "http://127.0.0.1:38886" },
    };
    const fetchStatus = async (port: number) => answers[port];
    expect(await findLocalHostId([1, 2, 3], "http://127.0.0.1:38886", fetchStatus)).toBe("host_ours");
    expect(await findLocalHostId([3], "http://127.0.0.1:38886", fetchStatus)).toBeNull();
    expect(await findLocalHostId([9], null, () => Promise.reject(new Error("refused")))).toBeNull();
  });
});
