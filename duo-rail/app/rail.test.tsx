// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rpcContract } from "../shared/contract";
import { DEFAULT_BUTTONS, defaultLayout, type Layout, type RailButton } from "../shared/layout";
import { BOTTOM_MARGIN, type Insets } from "../shared/placement";
import type { Viewport } from "./insets";

// jsdom resolves no env(), so the viewport is what each test says it is.
const viewport = vi.hoisted(() => ({ current: { insets: { top: 0, right: 0, bottom: 0, left: 0 }, height: 678 } as Viewport }));
vi.mock("./insets", async (original) => ({ ...(await original<typeof import("./insets")>()), useViewport: () => viewport.current }));

const DUO: Insets = { top: 0, right: 84, bottom: 34, left: 0 };
/** The unfolded display: bb's wide layout, 951×669 pt, an 85 pt strip on the right. */
const UNFOLDED: Insets = { top: 0, right: 85, bottom: 21, left: 0 };

const layout = (folded: RailButton[], unfolded: RailButton[] = [...DEFAULT_BUTTONS]): Layout => ({ version: 1, folded: { buttons: folded }, unfolded: { buttons: unfolded } });

const PIN_TARGET_THREAD = {
  id: "current",
  projectId: "p1",
  displayTitle: "On screen",
  parentThreadId: null,
  parentNotifications: "all",
  archivedAt: null,
  pinnedAt: null,
  sectionId: null,
  isUnread: false,
  isHidden: false,
  isArchived: false,
  hasPendingInteraction: false,
  latestAttentionAt: 1,
  status: "idle",
  environment: { id: "env1", path: "/work/acme" },
} as never;

function setCompact(compact: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("max-width: 767px") ? compact : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

/** Renders the overlay; `stored` is what the server's `layout.get` answers (the default when omitted). */
async function renderRail({ stored, ...options }: Parameters<typeof renderSlot>[2] & { stored?: Layout | { layout: Layout; problem: string } } = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const [overlay] = app.appOverlays;
  if (overlay === undefined) throw new Error("no app overlay registered");
  const answer = stored === undefined ? { layout: defaultLayout(), problem: null } : "problem" in stored ? stored : { layout: stored, problem: null };
  const slot = await renderSlot(overlay, {}, { experimental_rpcContract: rpcContract, rpc: { "layout.get": () => answer, "layout.set": (input) => input }, ...options });
  // The layout arrives from the server after the first render.
  await screen.findByTestId("duo-rail-probe");
  await new Promise((resolve) => setTimeout(resolve, 0));
  return slot;
}

beforeEach(() => {
  viewport.current = { insets: DUO, height: 678 };
  setCompact(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the rail", () => {
  it("stands Back, New thread and More on the bottom of the folded Duo's strip, clear of the home indicator", async () => {
    await renderRail();
    const rail = screen.getByTestId("duo-rail");
    expect(rail.dataset.side).toBe("right");
    expect(rail.style.bottom).toBe(`${34 + BOTTOM_MARGIN}px`);
    expect(rail.style.top).toBe("");
    expect(rail.style.right).toBe("0px");
    expect(rail.style.width).toBe("84px");
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Back", "New thread", "More"]);
  });

  it("lets taps through everywhere but its buttons", async () => {
    await renderRail();
    expect(screen.getByTestId("duo-rail").style.pointerEvents).toBe("none");
    for (const button of screen.getAllByRole("button")) expect(button.className).toContain("pointer-events-auto");
  });

  it("stays at the bottom whatever the camera gap, and is hidden when the column would reach above it", async () => {
    await renderRail({ settings: { cameraClearance: 235 } });
    expect(screen.getByTestId("duo-rail").style.bottom).toBe(`${34 + BOTTOM_MARGIN}px`);
    cleanup();
    // Three buttons stand from 678 − 42 − 156 = 480 pt down: a gap of 481 leaves them no room.
    await renderRail({ settings: { cameraClearance: 481 } });
    expect(screen.queryByTestId("duo-rail")).toBeNull();
  });

  it("mirrors to the left strip", async () => {
    viewport.current = { insets: { top: 0, right: 0, bottom: 34, left: 84 }, height: 678 };
    await renderRail();
    const rail = screen.getByTestId("duo-rail");
    expect(rail.dataset.side).toBe("left");
    expect(rail.style.left).toBe("0px");
  });

  it("stands the unfolded buttons on the bottom of the unfolded display's strip, on bb's wide layout", async () => {
    setCompact(false);
    viewport.current = { insets: UNFOLDED, height: 669 };
    await renderRail({ settings: { cameraClearanceUnfolded: 130 }, stored: layout([], [{ id: "fwd", label: "Forward", icon: "ArrowRight", action: { kind: "forward" } }]) });
    const rail = screen.getByTestId("duo-rail");
    expect(rail.dataset.display).toBe("unfolded");
    expect(rail.style.bottom).toBe(`${21 + BOTTOM_MARGIN}px`);
    expect(rail.style.width).toBe("85px");
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Forward"]);
  });

  it("limits the unfolded column by the unfolded gap, not the folded one", async () => {
    setCompact(false);
    viewport.current = { insets: UNFOLDED, height: 669 };
    const one = layout([], [{ id: "fwd", label: "Forward", icon: "ArrowRight", action: { kind: "forward" } }]);
    // One button stands from 669 − 29 − 48 = 592 pt down.
    await renderRail({ settings: { cameraClearance: 600, cameraClearanceUnfolded: 592 }, stored: one });
    expect(screen.getByTestId("duo-rail")).toBeTruthy();
    cleanup();
    await renderRail({ settings: { cameraClearance: 0, cameraClearanceUnfolded: 593 }, stored: one });
    expect(screen.queryByTestId("duo-rail")).toBeNull();
  });

  it("draws nothing on a desktop window, wide or narrow", async () => {
    viewport.current = { insets: { top: 0, right: 0, bottom: 0, left: 0 }, height: 800 };
    setCompact(false);
    await renderRail();
    expect(screen.queryByTestId("duo-rail")).toBeNull();
    cleanup();
    setCompact(true);
    await renderRail();
    expect(screen.queryByTestId("duo-rail")).toBeNull();
  });

  it("draws the owner's folded buttons, in their order", async () => {
    await renderRail({
      stored: layout([
          { id: "u", label: "Docs", icon: "Globe", action: { kind: "openUrl", url: "https://example.com/docs" } },
          { id: "b", label: "Back", icon: "ArrowLeft", action: { kind: "back" } },
        ]),
    });
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Docs", "Back"]);
  });

  it("draws nothing on a display whose layout has no buttons", async () => {
    await renderRail({ stored: layout([]) });
    expect(screen.queryByTestId("duo-rail")).toBeNull();
  });

  it("draws the default buttons when the server could not read the stored layout", async () => {
    await renderRail({ stored: { layout: defaultLayout(), problem: "The saved layout could not be read" } });
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Back", "New thread", "More"]);
  });

  it("opens a URL, a thread, a project and a new thread in a chosen project", async () => {
    const slot = await renderRail({
      openUrl: () => true,
      stored: layout([
          { id: "u", label: "Docs", icon: "Globe", action: { kind: "openUrl", url: "https://example.com/docs" } },
          { id: "t", label: "Standup", icon: "MessageSquare", action: { kind: "openThread", threadId: "t9" } },
          { id: "p", label: "Acme", icon: "Folder", action: { kind: "openProject", projectId: "p1" } },
          { id: "n", label: "New in Acme", icon: "Plus", action: { kind: "newThread", projectId: "p1" } },
        ]),
    });
    for (const name of ["Docs", "Standup", "Acme", "New in Acme"]) fireEvent.click(screen.getByRole("button", { name }));
    expect(slot.inspection.navigateCalls).toEqual([
      expect.objectContaining({ method: "openUrl", url: "https://example.com/docs" }),
      expect.objectContaining({ method: "toThread", threadId: "t9" }),
      expect.objectContaining({ method: "toProject", projectId: "p1" }),
      expect.objectContaining({ method: "toCompose", options: { projectId: "p1" } }),
    ]);
  });

  it("runs a thread-menu action on the open thread", async () => {
    const run = vi.fn(async () => {});
    const seen: string[] = [];
    await renderRail({
      context: { threadId: "current" },
      sidebarThreads: { threads: [PIN_TARGET_THREAD] },
      threadActions: (thread) => {
        seen.push(thread.id);
        return [{ key: "bb--core/pin", pluginId: "bb--core", group: "1_state", action: { label: "Pin", icon: "Pin", run } }];
      },
      stored: layout([{ id: "pin", label: "Pin", icon: "Pin", action: { kind: "threadAction", key: "bb--core/pin" } }]),
    });
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    expect(run).toHaveBeenCalledOnce();
    expect(seen).toContain("current");
  });

  it("keeps the rail showing over the page, a greyed-out thread action and the tool panel, and hides it under the drawer", async () => {
    // The browser's hit test, modelled: an element takes the pointer unless the nearest pointer-events rule
    // (inline, a class, or a `disabled:` class on a disabled button) says none. Each rail button gets a box.
    const takesPointer = (element: Element): boolean => {
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        const tokens = (node.getAttribute("class") ?? "").split(/\s+/);
        const disabled = node instanceof HTMLButtonElement && node.disabled;
        const variant = disabled ? tokens.find((token) => token === "disabled:pointer-events-none" || token === "disabled:pointer-events-auto") : undefined;
        const value = variant?.slice("disabled:".length) ?? (node as HTMLElement).style.pointerEvents ?? "";
        const resolved = value !== "" ? value : tokens.find((token) => token === "pointer-events-none" || token === "pointer-events-auto");
        if (resolved !== undefined) return !resolved.endsWith("none");
      }
      return true;
    };
    // A full-screen layer of bb's: the page and the tool panel pad themselves out of the strip, the
    // drawer's tap-to-close layer does not.
    const fullScreen = (paddingRight: string) => {
      const element = document.createElement("div");
      element.style.paddingRight = paddingRight;
      element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 466, height: 678, right: 466, bottom: 678, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      document.body.appendChild(element);
      return element;
    };
    const page = fullScreen("84px");
    const layers: Element[] = [];
    const boxes = new Map<Element, DOMRect>();
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
    // Topmost first: the rail's button (stacked over bb's layers) unless it is inert or takes no pointer, then the layers.
    document.elementsFromPoint = (x: number, y: number) => {
      const hit = [...boxes].find(([, box]) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)?.[0];
      const onRail = hit !== undefined && takesPointer(hit) && hit.closest("[inert]") === null ? [hit] : [];
      return [...onRail, ...layers, page, document.body];
    };
    await renderRail({
      context: { threadId: null },
      stored: layout([...DEFAULT_BUTTONS.slice(0, 1), { id: "pin", label: "Pin", icon: "Pin", action: { kind: "threadAction", key: "bb--core/pin" } }]),
    });
    const rail = screen.getByTestId("duo-rail");
    rail.querySelectorAll("button").forEach((button, index) => {
      const box = { left: 400, top: 500 + index * 60, width: 48, height: 48, right: 448, bottom: 548 + index * 60, x: 400, y: 500 + index * 60, toJSON: () => ({}) } as DOMRect;
      boxes.set(button, box);
      button.getBoundingClientRect = () => box;
    });
    const settle = async () => {
      fireEvent(window, new Event("resize"));
      await act(async () => {
        while (frames.length > 0) frames.shift()?.(0);
      });
    };
    await settle();
    expect(screen.getByRole("button", { name: "Pin" })).toHaveProperty("disabled", true);
    expect(rail.getAttribute("data-covered")).toBeNull();
    expect(rail.style.opacity).toBe("1");
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    // A thread's right pane on the folded screen: bb's full-page tool panel, under the rail (the owner's bug).
    const panel = fullScreen("84px");
    layers.unshift(panel);
    await settle();
    expect(rail.getAttribute("data-covered")).toBeNull();
    expect(rail.style.opacity).toBe("1");
    expect(rail.hasAttribute("inert")).toBe(false);
    layers.splice(0);
    // The drawer's tap-to-close layer, under the rail too, hides it, and taps then go through to the layer.
    const drawer = fullScreen("");
    layers.unshift(drawer);
    await settle();
    expect(rail.getAttribute("data-covered")).toBe("true");
    expect(rail.style.opacity).toBe("0");
    expect(rail.hasAttribute("inert")).toBe(true);
    expect(document.elementsFromPoint(424, 524)[0]).toBe(drawer);
    layers.splice(0);
    await settle();
    expect(rail.getAttribute("data-covered")).toBeNull();
    expect(rail.hasAttribute("inert")).toBe(false);
  });

  it("greys out a thread-menu action when no thread is open", async () => {
    await renderRail({
      context: { threadId: null },
      stored: layout([{ id: "pin", label: "Pin", icon: "Pin", action: { kind: "threadAction", key: "bb--core/pin" } }]),
    });
    expect(screen.getByRole("button", { name: "Pin" })).toHaveProperty("disabled", true);
  });

  it("opens the recent threads from a button of their own", async () => {
    const thread = (id: string, displayTitle: string, latestAttentionAt: number) =>
      ({ id, displayTitle, isHidden: false, isArchived: false, isUnread: false, hasPendingInteraction: false, latestAttentionAt }) as never;
    const slot = await renderRail({
      sidebarThreads: { threads: [thread("t1", "First", 1), thread("t2", "Second", 2), thread("t3", "Third", 3)] },
      stored: layout([{ id: "r", label: "Recent", icon: "Clock", action: { kind: "recentThreads", count: 2 } }]),
    });
    fireEvent.click(screen.getByRole("button", { name: "Recent" }));
    expect(await screen.findByText("Third")).toBeTruthy();
    expect(screen.queryByText("First")).toBeNull();
    fireEvent.click(screen.getByText("Second"));
    expect(slot.inspection.navigateCalls).toEqual([expect.objectContaining({ method: "toThread", threadId: "t2" })]);
  });

  it("runs a bb command in a terminal on the server's machine", async () => {
    const create = vi.fn(async () => ({ id: "term1" }));
    const slot = await renderRail({
      sdk: {
        system: { experimental_cliCommand: async () => ({ installedPath: "/usr/local/bin/bb", onPath: true, shadowedBy: null, supported: true }), config: async () => ({ primaryHostId: "host1" }) },
        terminals: {
          create,
          output: async () => ({ chunks: [{ seq: 1, dataBase64: btoa("said it\n\u001b]5253;duo-rail;exit;0\u0007") }], nextSeq: 2, status: "running", exitCode: null, closeReason: null, truncated: false }),
          close: async () => ({}),
        },
      } as never,
      stored: layout([{ id: "say", label: "Say", icon: "Mic", action: { kind: "bbCommand", args: ["herald", "say", "hi there"] } }]),
    });
    fireEvent.click(screen.getByRole("button", { name: "Say" }));
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]).toEqual([
      expect.objectContaining({
        scope: { kind: "host_path", hostId: "host1", cwd: null },
        start: { mode: "argv", argv: ["/bin/sh", "-c", expect.any(String), "/usr/local/bin/bb", "herald", "say", "hi there"] },
      }),
    ]);
    await vi.waitFor(() => expect(slot.inspection.sdkCalls.map((call) => call.method)).toContain("terminals.close"));
  });

  it("stops a running command and closes its terminal when the page goes away", async () => {
    const close = vi.fn(async () => ({}));
    await renderRail({
      sdk: {
        system: { experimental_cliCommand: async () => ({ installedPath: "/usr/local/bin/bb", onPath: true, shadowedBy: null, supported: true }), config: async () => ({ primaryHostId: "host1" }) },
        terminals: {
          create: async () => ({ id: "term1" }),
          // `bb plugin logs … -f`: it never ends, and a read may not answer either.
          output: () => new Promise(() => {}),
          close,
        },
      } as never,
      stored: layout([{ id: "logs", label: "Logs", icon: "Mic", action: { kind: "bbCommand", args: ["plugin", "logs", "herald", "-f"] } }]),
    });
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(close).not.toHaveBeenCalled();
    fireEvent(window, new Event("pagehide"));
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith({ terminalId: "term1", mode: "force" }));
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

describe("the debug numbers", () => {
  const setInnerWidth = (width: number) => Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  afterEach(() => setInnerWidth(1024));

  it("are off by default", async () => {
    await renderRail();
    expect(screen.getByTestId("duo-rail")).toBeTruthy();
    expect(screen.queryByTestId("duo-rail-debug")).toBeNull();
  });

  it("show above the rail's top button when turned on, with the display and the camera gap in use", async () => {
    await renderRail({ settings: { cameraClearance: 220, showDebugNumbers: true } });
    const readout = screen.getByTestId("duo-rail-debug");
    const rail = screen.getByTestId("duo-rail");
    // In the strip-wide rail, above its column and out of its flow, so no button moves.
    expect(readout.parentElement).toBe(rail);
    expect(rail.style.width).toBe("84px");
    expect(readout.style.position).toBe("absolute");
    expect(readout.style.bottom).toBe("100%");
    expect(readout.style.left).toBe("0px");
    expect(readout.style.right).toBe("0px");
    // Wraps rather than cuts a value.
    expect(readout.style.whiteSpace).toBe("normal");
    expect(readout.style.overflowWrap).toBe("anywhere");
    expect(readout.style.pointerEvents).toBe("none");
    expect(readout.textContent).toContain("folded");
    expect(readout.textContent).toContain("gap 220");
    expect(readout.textContent).toContain(`win ${window.innerWidth}×${window.innerHeight}`);
  });

  it("follow a change that fires no event, on the half-second timer", async () => {
    await renderRail({ settings: { showDebugNumbers: true } });
    setInnerWidth(466);
    await vi.waitFor(() => expect(screen.getByTestId("duo-rail-debug").textContent).toContain(`win 466×${window.innerHeight}`), { timeout: 1500 });
  });

  it("are gone when Show debug numbers is off", async () => {
    await renderRail({ settings: { showDebugNumbers: false } });
    expect(screen.getByTestId("duo-rail")).toBeTruthy();
    expect(screen.queryByTestId("duo-rail-debug")).toBeNull();
  });

  it("are not drawn where the rail is not", async () => {
    viewport.current = { insets: { top: 0, right: 0, bottom: 0, left: 0 }, height: 678 };
    await renderRail({ settings: { showDebugNumbers: true } });
    expect(screen.queryByTestId("duo-rail-debug")).toBeNull();
  });
});
