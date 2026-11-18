// @vitest-environment jsdom
/**
 * The rail against the SDK's slot harness: bb's shared preferences on a wide
 * screen, the phone layout on a compact one, and where each edit goes.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ExperimentalSidebarNavigationItem,
  ExperimentalSidebarNavigationProps,
} from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

import type { RpcContract } from "./shared/contract";
import { LAYOUT_CHANGED_CHANNEL, type NavigationLayout } from "./shared/layout";
import { CACHE_KEY } from "./app/phone-layout";

const app = await loadPluginApp(() => import("./app"));
const rail = app.experimentalSidebarNavigations.find((registration) => registration.id === "rail");
if (!rail) throw new Error("the rail is not registered");

function hostItem(
  id: string,
  label: string,
  action: ExperimentalSidebarNavigationItem["action"],
  overrides: Partial<ExperimentalSidebarNavigationItem> = {},
): ExperimentalSidebarNavigationItem {
  return {
    id,
    label,
    icon: { kind: "host", name: "extensions" },
    action,
    isDisabled: false,
    isVisible: true,
    isLoading: false,
    pluginId: null,
    shortcut: null,
    badge: null,
    ...overrides,
  };
}

function panelItem(pluginId: string, panelId: string, label: string): ExperimentalSidebarNavigationItem {
  return {
    ...hostItem(`${pluginId}/${panelId}`, label, { kind: "open-plugin-panel", pluginId, panelId }),
    icon: { kind: "plugin", pluginId, icon: "BookOpen" },
    pluginId,
  };
}

const NEW_THREAD = hostItem("__bb__/new-thread", "New thread", { kind: "new-thread" });
const PLUGINS = hostItem("__bb__/extensions", "Plugins", { kind: "open-extensions" });
const DOCS = panelItem("garden", "docs", "Docs");
const BOARD = panelItem("board", "board", "Board");
const ITEMS = [NEW_THREAD, PLUGINS, DOCS, BOARD];

const PHONE: NavigationLayout = { visible: ["board/board"], order: ["board/board", "__bb__/extensions", "garden/docs"] };

/** A server with one stored layout, recording what the app saves. */
function server(initial: NavigationLayout | null) {
  let stored = initial;
  const saved: (NavigationLayout | null)[] = [];
  return {
    saved,
    rpc: {
      getPhoneLayout: () => ({ layout: stored }),
      setPhoneLayout: ({ layout }: { layout: NavigationLayout | null }) => {
        stored = layout;
        saved.push(layout);
        return {};
      },
    },
  };
}

function renderRail(options: { compact: boolean; layout?: NavigationLayout | null }) {
  const backend = server(options.layout ?? null);
  const props: ExperimentalSidebarNavigationProps = {
    isCompactViewport: options.compact,
    placement: "rail",
    experimental_Original: () => null,
  };
  const view = renderSlot<ExperimentalSidebarNavigationProps, RpcContract>(rail!, props, {
    rpc: backend.rpc,
    sidebarNavigation: { items: ITEMS, activeItemId: null, isHomeActive: true },
  });
  return { view, backend };
}

function railLabels(): (string | null)[] {
  return within(screen.getByTestId("app-nav-rail"))
    .getAllByRole("button", { hidden: true }) // an open editor hides the page from assistive tech
    .map((button) => button.getAttribute("aria-label"));
}

/** Waits for the layout request to answer. */
async function settled(view: ReturnType<typeof renderRail>["view"]) {
  await waitFor(() => expect(view.inspection.rpcCalls.length).toBeGreaterThan(0));
  await act(async () => {});
}

function openMore() {
  const more = screen.getByRole("button", { name: "More" });
  fireEvent.pointerDown(more, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("on a wide screen", () => {
  it("draws bb's shared preferences, whatever the phone layout says", async () => {
    const { view } = renderRail({ compact: false, layout: PHONE });
    await settled(view);
    expect(railLabels()).toEqual(["Home", "Plugins", "Docs", "Board", "More"]);
  });

  it("hides through bb, and offers bb's editor and the phone editor in More", async () => {
    const { view, backend } = renderRail({ compact: false, layout: PHONE });
    await settled(view);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Docs" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Hide from rail" }));
    expect(view.inspection.sidebarNavigationCalls).toContainEqual({
      method: "setVisible",
      itemId: "garden/docs",
      isVisible: false,
    });

    openMore();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Customize navigation" }));
    expect(view.inspection.sidebarNavigationCalls).toContainEqual({ method: "openCustomize" });

    openMore();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Customize phone navigation" }));
    const editor = await screen.findByTestId("phone-rail-editor");
    // The editor lists what phones show, not what this screen shows.
    expect(within(editor).getByRole("checkbox", { name: "Show Board in sidebar" }).getAttribute("aria-checked")).toBe("true");
    expect(within(editor).getByRole("checkbox", { name: "Show Docs in sidebar" }).getAttribute("aria-checked")).toBe("false");
    expect(backend.saved).toEqual([]);
  });
});

describe("on a phone", () => {
  it("follows bb's shared preferences until the phone has a layout", async () => {
    const { view } = renderRail({ compact: true, layout: null });
    await settled(view);
    expect(railLabels()).toEqual(["Home", "Plugins", "Docs", "Board", "More"]);
    // One load per mount, not one per render.
    await act(async () => {});
    expect(view.inspection.rpcCalls.map((call) => call.method)).toEqual(["getPhoneLayout"]);
  });

  it("draws the phone layout, with the rest in More", async () => {
    const { view } = renderRail({ compact: true, layout: PHONE });
    await settled(view);
    expect(railLabels()).toEqual(["Home", "Board", "More"]);

    openMore();
    const menu = await screen.findByTestId("nav-rail-more-menu");
    expect(within(menu).getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual([
      "Plugins",
      "Docs",
      "Customize navigation",
    ]);
  });

  it("hides on the phone only, starting from bb's shared preferences", async () => {
    const { view, backend } = renderRail({ compact: true, layout: null });
    await settled(view);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Docs" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Hide from rail" }));

    expect(railLabels()).toEqual(["Home", "Plugins", "Board", "More"]);
    await waitFor(() =>
      expect(backend.saved).toEqual([
        {
          visible: ["__bb__/new-thread", "__bb__/extensions", "board/board"],
          order: ["__bb__/new-thread", "__bb__/extensions", "garden/docs", "board/board"],
        },
      ]),
    );
    expect(view.inspection.sidebarNavigationCalls.filter((call) => call.method === "setVisible")).toEqual([]);
  });

  it("opens the phone editor from Customize navigation, and its tick shows an icon", async () => {
    const { view, backend } = renderRail({ compact: true, layout: PHONE });
    await settled(view);

    openMore();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Customize navigation" }));
    expect(view.inspection.sidebarNavigationCalls).not.toContainEqual({ method: "openCustomize" });

    const editor = await screen.findByTestId("phone-rail-editor");
    fireEvent.click(within(editor).getByRole("checkbox", { name: "Show Docs in sidebar" }));
    expect(railLabels()).toEqual(["Home", "Board", "Docs", "More"]);
    await waitFor(() => expect(backend.saved.at(-1)?.visible).toEqual(["board/board", "__bb__/new-thread", "garden/docs"]));
  });

  it("goes back to bb's shared preferences from the editor", async () => {
    const { view, backend } = renderRail({ compact: true, layout: PHONE });
    await settled(view);

    openMore();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Customize navigation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Same as wider windows" }));

    expect(railLabels()).toEqual(["Home", "Plugins", "Docs", "Board", "More"]);
    await waitFor(() => expect(backend.saved).toEqual([null]));
  });

  it("redraws when another device changes the layout", async () => {
    const { view } = renderRail({ compact: true, layout: null });
    await settled(view);

    await view.behavior.emitRealtime(LAYOUT_CHANGED_CHANNEL, { layout: PHONE });
    expect(railLabels()).toEqual(["Home", "Board", "More"]);
  });

  it("draws the layout this browser saw last before the server answers", () => {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(PHONE));
    renderRail({ compact: true, layout: PHONE });
    expect(railLabels()).toEqual(["Home", "Board", "More"]);
  });
});
