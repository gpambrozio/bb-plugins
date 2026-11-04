// @vitest-environment jsdom
/**
 * The page against a fake server: "+" opens straight away with one machine
 * and asks with several, tabs close, and an ended shell says so. The
 * terminals themselves (xterm and bb's socket) are replaced by a stub whose
 * status the test sets.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { renderSlot, type PluginRpcTestHandlers, type RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { RpcContract } from "../shared/contract";
import type { HostChoice, TabView } from "../shared/tabs";
import type { ConnectionStatus } from "./connection";

const terminals = vi.hoisted(() => {
  type Listener = (status: ConnectionStatus) => void;
  interface Entry {
    status: ConnectionStatus;
    listeners: Set<Listener>;
    attached: number;
    /** What xterm reports as selected. */
    selection: string;
    selectionListeners: Set<() => void>;
    scrollListeners: Set<() => void>;
    cwd: string | null;
  }
  const entries = new Map<string, Entry>();
  function entry(terminalId: string) {
    let found = entries.get(terminalId);
    if (found === undefined) {
      found = {
        status: { state: "live", exitCode: null },
        listeners: new Set(),
        attached: 0,
        selection: "",
        selectionListeners: new Set(),
        scrollListeners: new Set(),
        cwd: null,
      };
      entries.set(terminalId, found);
    }
    return found;
  }
  return {
    entries,
    entry,
    setStatus(terminalId: string, status: ConnectionStatus) {
      const found = entry(terminalId);
      found.status = status;
      for (const listener of found.listeners) listener(status);
    },
    /** The selection changes, as xterm reports it — by a drag, or by output and programs. */
    setSelection(terminalId: string, text: string) {
      const found = entry(terminalId);
      found.selection = text;
      for (const listener of found.selectionListeners) listener();
    },
    scroll(terminalId: string) {
      for (const listener of entry(terminalId).scrollListeners) listener();
    },
  };
});

const toasts = vi.hoisted(() => ({ success: [] as string[], error: [] as string[] }));
vi.mock("sonner", () => ({
  toast: {
    success: (message: string) => void toasts.success.push(message),
    error: (message: string) => void toasts.error.push(message),
  },
}));

vi.mock("./live-terminals", () => ({
  liveTerminal: (terminalId: string) => {
    const found = terminals.entry(terminalId);
    return {
      terminalId,
      status: () => found.status,
      onStatus: (listener: (status: ConnectionStatus) => void) => {
        found.listeners.add(listener);
        return () => found.listeners.delete(listener);
      },
      attach: () => void (found.attached += 1),
      detach: () => undefined,
      fit: () => undefined,
      focus: () => undefined,
      applyTheme: () => undefined,
      selection: () => found.selection,
      clearSelection: () => terminals.setSelection(terminalId, ""),
      onSelectionChange: (listener: () => void) => {
        found.selectionListeners.add(listener);
        return () => found.selectionListeners.delete(listener);
      },
      onScroll: (listener: () => void) => {
        found.scrollListeners.add(listener);
        return () => found.scrollListeners.delete(listener);
      },
      cwd: () => found.cwd,
    };
  },
  releaseClosedTerminals: (open: ReadonlySet<string>) => {
    for (const id of [...terminals.entries.keys()]) if (!open.has(id)) terminals.entries.delete(id);
  },
  applyThemeToAll: () => undefined,
}));

const { TerminalsPage } = await import("./terminals-page");
const { windowSelection } = await import("./selection");
const { windowDeliveries } = await import("./chat-delivery");

beforeAll(() => {
  // jsdom has neither; the compact-viewport hook and the terminal's fit ask them.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  terminals.entries.clear();
  windowSelection.set(null);
  toasts.success.length = 0;
  toasts.error.length = 0;
  const pending = windowDeliveries.get();
  if (pending !== null) windowDeliveries.finish(pending);
});

afterEach(() => cleanup());

function tab(terminalId: string, hostId: string, hostName: string): TabView {
  return { terminalId, hostId, hostName, createdAt: 0, name: null, status: "running", exitCode: null };
}

/** A fake server holding a tab list, with the given machines connected. */
function server(hosts: HostChoice[], initial: TabView[] = []) {
  const state = {
    tabs: [...initial],
    opened: [] as string[],
    closed: [] as string[],
    renamed: [] as [string, string | null][],
    moved: [] as [string, string][],
    /** While set, each list call answers only when the test calls the function it leaves in `heldLists`. */
    holdLists: false,
    heldLists: [] as (() => void)[],
  };
  let next = initial.length + 1;
  const rpc = {
    hosts: () => ({ hosts }),
    list: () => {
      // The list as it was when asked, however late the answer comes.
      const snapshot = { tabs: state.tabs };
      if (!state.holdLists) return snapshot;
      return new Promise((resolve) => state.heldLists.push(() => resolve(snapshot)));
    },
    open: ({ hostId }: { hostId: string }) => {
      const host = hosts.find((entry) => entry.id === hostId)!;
      const opened = tab(`term_${next++}`, hostId, host.name);
      state.tabs = [...state.tabs, opened];
      state.opened.push(hostId);
      return opened;
    },
    rename: ({ terminalId, name }: { terminalId: string; name: string | null }) => {
      state.renamed.push([terminalId, name]);
      state.tabs = state.tabs.map((entry) => (entry.terminalId === terminalId ? { ...entry, name } : entry));
      return {};
    },
    move: ({ terminalId, toTerminalId }: { terminalId: string; toTerminalId: string }) => {
      state.moved.push([terminalId, toTerminalId]);
      const from = state.tabs.findIndex((entry) => entry.terminalId === terminalId);
      const to = state.tabs.findIndex((entry) => entry.terminalId === toTerminalId);
      const tabs = [...state.tabs];
      tabs.splice(to, 0, ...tabs.splice(from, 1));
      state.tabs = tabs;
      return {};
    },
    close: ({ terminalId }: { terminalId: string }) => {
      state.tabs = state.tabs.filter((entry) => entry.terminalId !== terminalId);
      state.closed.push(terminalId);
      return {};
    },
  } as unknown as PluginRpcTestHandlers<RpcContract>;
  return { state, rpc };
}

/** What bb answers for its own settings and projects, and the sidebar's threads. */
interface Host {
  copyOnSelect?: boolean;
  projects?: { id: string; sources: { hostId: string; path: string }[] }[];
  sidebarThreads?: RenderSlotOptions<RpcContract>["sidebarThreads"];
  configReads?: { count: number };
  /** Filled in by the page's `system:config-changed` subscription, to say bb saved its settings. */
  configChanged?: Set<() => void>;
}

function render(rpc: PluginRpcTestHandlers<RpcContract>, host: Host = {}) {
  const sdk = {
    system: {
      config: async () => {
        if (host.configReads !== undefined) host.configReads.count += 1;
        return { generalSettings: { terminalCopyOnSelect: host.copyOnSelect ?? true } };
      },
    },
    projects: { list: async () => host.projects ?? [] },
    subscribe: ({ event, callback }: { event: string; callback: () => void }) => {
      if (event !== "system:config-changed") return () => {};
      host.configChanged ??= new Set();
      const listeners = host.configChanged;
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  } as unknown as RenderSlotOptions<RpcContract>["sdk"];
  return renderSlot<PluginNavPanelProps, RpcContract>(
    { component: TerminalsPage },
    { subPath: "" },
    { rpc, sdk, sidebarThreads: host.sidebarThreads, experimental_copyToClipboard: async () => true },
  );
}

/** The strip's tabs in the order it shows them: each pill's own button, not its close button. */
function tabButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[data-strip-tab] [data-tab-pill] > button:not([data-tab-pill-close])"));
}

function pressPlus() {
  const plus = within(screen.getByRole("toolbar", { name: "Terminals" })).getByRole("button", { name: "New terminal" });
  fireEvent.pointerDown(plus, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("the Terminals page", () => {
  it("starts empty, and + opens a terminal on the only machine without asking", async () => {
    const { state, rpc } = server([{ id: "mini", name: "Mac mini" }]);
    render(rpc);
    expect(await screen.findByText(/No terminals open/)).toBeTruthy();
    pressPlus();
    expect(await screen.findByRole("button", { name: "Mac mini" })).toBeTruthy();
    expect(state.opened).toEqual(["mini"]);
    expect(screen.queryByText("Open a terminal on")).toBeNull();
    expect(screen.getByRole("button", { name: "Mac mini" }).getAttribute("aria-pressed")).toBe("true");
    expect(terminals.entry("term_1").attached).toBeGreaterThan(0);
  });

  it("asks which machine when several are connected, and opens on the one picked", async () => {
    const { state, rpc } = server([
      { id: "mini", name: "Mac mini" },
      { id: "air", name: "MacBook Air" },
    ]);
    render(rpc);
    await screen.findByText(/No terminals open/);
    pressPlus();
    const air = await screen.findByRole("menuitem", { name: /MacBook Air/ });
    expect(screen.getByRole("menuitem", { name: /Mac mini/ })).toBeTruthy();
    fireEvent.click(air);
    expect(await screen.findByRole("button", { name: "MacBook Air" })).toBeTruthy();
    expect(state.opened).toEqual(["air"]);
  });

  it("says so when no machine is connected", async () => {
    const { state, rpc } = server([]);
    render(rpc);
    await screen.findByText(/No terminals open/);
    pressPlus();
    expect(await screen.findByText(/No machine is connected/)).toBeTruthy();
    expect(state.opened).toEqual([]);
  });

  it("shows the server's tabs, numbered per machine, and closing one ends it and selects its neighbour", async () => {
    const { state, rpc } = server(
      [{ id: "mini", name: "Mac mini" }],
      [tab("term_1", "mini", "Mac mini"), tab("term_2", "mini", "Mac mini"), tab("term_3", "air", "MacBook Air")],
    );
    windowSelection.set("term_2");
    render(rpc);
    const second = await screen.findByRole("button", { name: "Mac mini 2" });
    expect(second.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close Mac mini 2" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Mac mini 2" })).toBeNull());
    expect(state.closed).toEqual(["term_2"]);
    expect(screen.getByRole("button", { name: "MacBook Air" }).getAttribute("aria-pressed")).toBe("true");
    // One Mac mini tab left, so it is no longer numbered.
    expect(screen.getByRole("button", { name: "Mac mini" })).toBeTruthy();
  });

  it("marks only the selected tab, the way bb marks its own, and moves the mark with the selection", async () => {
    const { rpc } = server(
      [{ id: "mini", name: "Mac mini" }],
      [tab("term_1", "mini", "Mac mini"), tab("term_2", "mini", "Mac mini")],
    );
    windowSelection.set("term_1");
    render(rpc);
    const first = await screen.findByRole("button", { name: "Mac mini 1" });
    const second = screen.getByRole("button", { name: "Mac mini 2" });
    // bb's tab pill: the element around the tab's button and its close button.
    const pill = (button: HTMLElement) => button.closest("[data-tab-pill]") as HTMLElement;

    // bb's "active" fill and full-strength text, against dimmer text on the others.
    expect(pill(first).className).toMatch(/\bbg-state-active\b/);
    expect(pill(first).className).toMatch(/\btext-foreground\b/);
    expect(pill(second).className).not.toMatch(/\bbg-state-active\b/);
    expect(pill(second).className).toMatch(/\btext-muted-foreground\b/);
    expect([first.getAttribute("aria-pressed"), second.getAttribute("aria-pressed")]).toEqual(["true", "false"]);

    fireEvent.click(second);
    await waitFor(() => expect(second.getAttribute("aria-pressed")).toBe("true"));
    expect(first.getAttribute("aria-pressed")).toBe("false");
    expect(pill(second).className).toMatch(/\bbg-state-active\b/);
    expect(pill(first).className).not.toMatch(/\bbg-state-active\b/);
  });

  it.each(["opening", "starting"] as const)("waits for a shell that is %s before attaching to it", async (status) => {
    const { state, rpc } = server([{ id: "mini", name: "Mac mini" }], [{ ...tab("term_1", "mini", "Mac mini"), status }]);
    render(rpc);
    expect(await screen.findByText("Starting the shell…")).toBeTruthy();
    // No terminal yet: attaching now would hear "not found" and call the shell ended.
    expect(terminals.entries.has("term_1")).toBe(false);
    state.tabs = [tab("term_1", "mini", "Mac mini")];
    await waitFor(() => expect(terminals.entries.get("term_1")?.attached).toBe(1), { timeout: 4_000 });
    expect(screen.queryByText("Starting the shell…")).toBeNull();
  });

  describe("reading the tab list", () => {
    const visibleTabs = () => tabButtons().map((element) => element.textContent);

    it("keeps the newest list when two reads answer in the reverse order", async () => {
      const { state, rpc } = server([{ id: "mini", name: "Mac mini" }], [tab("term_1", "mini", "Mac mini")]);
      const view = render(rpc);
      await screen.findByRole("button", { name: "Mac mini" });
      state.holdLists = true;
      await view.emitRealtime("tabs-changed", {});
      // Another window opens a tab; its signal starts a second read.
      state.tabs = [tab("term_1", "mini", "Mac mini"), tab("term_2", "mini", "Mac mini")];
      await view.emitRealtime("tabs-changed", {});
      expect(state.heldLists).toHaveLength(2);
      const [older, newer] = state.heldLists.splice(0);
      await act(async () => newer!());
      await screen.findByRole("button", { name: "Mac mini 2" });
      await act(async () => older!());
      expect(visibleTabs()).toEqual(["Mac mini 1", "Mac mini 2"]);
      expect(terminals.entries.has("term_2")).toBe(true);
    });

    it("does not bring back a tab this window closed when an older read answers after it", async () => {
      const { state, rpc } = server(
        [{ id: "mini", name: "Mac mini" }],
        [tab("term_1", "mini", "Mac mini"), tab("term_2", "mini", "Mac mini")],
      );
      const view = render(rpc);
      await screen.findByRole("button", { name: "Mac mini 2" });
      state.holdLists = true;
      await view.emitRealtime("tabs-changed", {});
      fireEvent.click(screen.getByRole("button", { name: "Close Mac mini 2" }));
      await waitFor(() => expect(state.closed).toEqual(["term_2"]));
      await waitFor(() => expect(state.heldLists).toHaveLength(2));
      const [beforeClose, afterClose] = state.heldLists.splice(0);
      await act(async () => afterClose!());
      await act(async () => beforeClose!());
      expect(visibleTabs()).toEqual(["Mac mini"]);
    });
  });

  it("says when a shell has ended and offers to close its tab", async () => {
    const { state, rpc } = server([{ id: "mini", name: "Mac mini" }], [tab("term_1", "mini", "Mac mini")]);
    render(rpc);
    await screen.findByRole("button", { name: "Mac mini" });
    act(() => terminals.setStatus("term_1", { state: "ended", exitCode: 130 }));
    expect(await screen.findByText("This shell exited with code 130.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    await waitFor(() => expect(state.closed).toEqual(["term_1"]));
    expect(await screen.findByText(/No terminals open/)).toBeTruthy();
  });

  it("says when a machine is offline", async () => {
    const { rpc } = server([{ id: "mini", name: "Mac mini" }], [tab("term_1", "mini", "Mac mini")]);
    render(rpc);
    await screen.findByRole("button", { name: "Mac mini" });
    act(() => terminals.setStatus("term_1", { state: "offline", exitCode: null }));
    expect(await screen.findByText(/This machine is offline/)).toBeTruthy();
  });

  describe("renaming a tab", () => {
    const twoTabs = () =>
      server([{ id: "mini", name: "Mac mini" }], [tab("term_1", "mini", "Mac mini"), tab("term_2", "mini", "Mac mini")]);

    async function editByDoubleClick(name: string) {
      fireEvent.doubleClick(await screen.findByRole("button", { name }));
      return (await screen.findByRole("textbox", { name: `Rename ${name}` })) as HTMLInputElement;
    }

    it("edits the title in place on a double click; Enter saves it for every client", async () => {
      const { state, rpc } = twoTabs();
      render(rpc);
      const input = await editByDoubleClick("Mac mini 2");
      expect(input.value).toBe("Mac mini 2");
      fireEvent.change(input, { target: { value: "  dev server " } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(await screen.findByRole("button", { name: "dev server" })).toBeTruthy();
      expect(state.renamed).toEqual([["term_2", "dev server"]]);
      // The other tab keeps its number.
      expect(screen.getByRole("button", { name: "Mac mini 1" })).toBeTruthy();
    });

    it("keeps the old title on Escape", async () => {
      const { state, rpc } = twoTabs();
      render(rpc);
      const input = await editByDoubleClick("Mac mini 1");
      fireEvent.change(input, { target: { value: "scratch" } });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(await screen.findByRole("button", { name: "Mac mini 1" })).toBeTruthy();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(state.renamed).toEqual([]);
    });

    it("brings back the default title for an empty name", async () => {
      const { state, rpc } = server([{ id: "mini", name: "Mac mini" }], [{ ...tab("term_1", "mini", "Mac mini"), name: "logs" }]);
      render(rpc);
      const input = await editByDoubleClick("logs");
      expect(input.value).toBe("logs");
      fireEvent.change(input, { target: { value: "   " } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(await screen.findByRole("button", { name: "Mac mini" })).toBeTruthy();
      expect(state.renamed).toEqual([["term_1", null]]);
    });

    it("saves when the field loses focus, and sends nothing for an untouched default title", async () => {
      const { state, rpc } = twoTabs();
      render(rpc);
      let input = await editByDoubleClick("Mac mini 1");
      fireEvent.blur(input);
      await screen.findByRole("button", { name: "Mac mini 1" });
      expect(state.renamed).toEqual([]);
      input = await editByDoubleClick("Mac mini 1");
      fireEvent.change(input, { target: { value: "build" } });
      fireEvent.blur(input);
      expect(await screen.findByRole("button", { name: "build" })).toBeTruthy();
      expect(state.renamed).toEqual([["term_1", "build"]]);
    });

    it("renames from the tab's context menu and with F2", async () => {
      const { state, rpc } = twoTabs();
      render(rpc);
      fireEvent.contextMenu(await screen.findByRole("button", { name: "Mac mini 1" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: /Rename/ }));
      let input = (await screen.findByRole("textbox", { name: "Rename Mac mini 1" })) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "one" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await screen.findByRole("button", { name: "one" });
      fireEvent.keyDown(screen.getByRole("button", { name: "Mac mini 2" }), { key: "F2" });
      input = (await screen.findByRole("textbox", { name: "Rename Mac mini 2" })) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "two" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await screen.findByRole("button", { name: "two" });
      expect(state.renamed).toEqual([
        ["term_1", "one"],
        ["term_2", "two"],
      ]);
    });

    /** Lets the frame the page waits for after an edit go by. */
    const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    it("puts focus back on the tab after Enter", async () => {
      const { rpc } = twoTabs();
      render(rpc);
      const input = await editByDoubleClick("Mac mini 1");
      fireEvent.change(input, { target: { value: "one" } });
      fireEvent.keyDown(input, { key: "Enter" });
      const renamed = await screen.findByRole("button", { name: "one" });
      await waitFor(() => expect(document.activeElement).toBe(renamed));
    });

    it("leaves focus in the next tab's rename field when that opens within a frame", async () => {
      // The previous edit's return to its tab comes a frame later; it must not close this field unsaved.
      const { state, rpc } = twoTabs();
      render(rpc);
      let input = await editByDoubleClick("Mac mini 1");
      fireEvent.change(input, { target: { value: "one" } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(await screen.findByRole("button", { name: "Mac mini 2" }), { key: "F2" });
      input = (await screen.findByRole("textbox", { name: "Rename Mac mini 2" })) as HTMLInputElement;
      await waitFor(() => expect(document.activeElement).toBe(input));
      await nextFrame();
      expect(screen.getByRole("textbox", { name: "Rename Mac mini 2" })).toBe(input);
      expect(document.activeElement).toBe(input);
      expect(state.renamed).toEqual([["term_1", "one"]]);
    });

    it("closes a tab from its context menu", async () => {
      const { state, rpc } = twoTabs();
      render(rpc);
      fireEvent.contextMenu(await screen.findByRole("button", { name: "Mac mini 2" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Close tab" }));
      await waitFor(() => expect(state.closed).toEqual(["term_2"]));
    });

    it("shows a name another client gave", async () => {
      const { rpc } = server([{ id: "mini", name: "Mac mini" }], [{ ...tab("term_1", "mini", "Mac mini"), name: "deploy" }]);
      render(rpc);
      const named = await screen.findByRole("button", { name: "deploy" });
      expect(named.querySelector("[title]")?.getAttribute("title")).toBe("deploy — Mac mini");
    });
  });

  describe("the tab strip", () => {
    const threeTabs = () =>
      server(
        [{ id: "mini", name: "Mac mini" }],
        [tab("term_1", "mini", "Mac mini"), tab("term_2", "mini", "Mac mini"), tab("term_3", "air", "MacBook Air")],
      );
    const shownTabs = () => tabButtons().map((element) => element.textContent);

    /** Lays the strip's tabs out side by side, 100 px each, as a browser would; jsdom lays out nothing. */
    function layOutTabs() {
      const original = Element.prototype.getBoundingClientRect;
      const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        const id = this.getAttribute("data-strip-tab");
        if (id === null) return original.call(this);
        const index = Array.from(document.querySelectorAll("[data-strip-tab]")).indexOf(this);
        // Where it shows, moved by any transform the drag gave it; dnd-kit takes that back out.
        const shift = /translate3d\((-?[\d.]+)px/.exec((this as HTMLElement).style.transform)?.[1];
        return new DOMRect(index * 100 + Number(shift ?? 0), 0, 100, 28);
      });
      return () => spy.mockRestore();
    }

    /** Drags the tab with the mouse by `dx` pixels and lets go, as dnd-kit's mouse sensor reads it. */
    async function dragTab(name: string, dx: number) {
      const button = screen.getByRole("button", { name });
      fireEvent.mouseDown(button, { button: 0, clientX: 50, clientY: 10 });
      // Past bb's 8 px before a press becomes a drag, then on to the drop.
      fireEvent.mouseMove(document, { clientX: 50 + Math.sign(dx) * 10, clientY: 10 });
      await act(async () => undefined);
      fireEvent.mouseMove(document, { clientX: 50 + dx, clientY: 10 });
      await act(async () => undefined);
      fireEvent.mouseUp(document, { clientX: 50 + dx, clientY: 10 });
      await act(async () => undefined);
    }

    it("moves a dragged tab where it is dropped, for every window, and keeps each tab's number", async () => {
      const { state, rpc } = threeTabs();
      windowSelection.set("term_1");
      render(rpc);
      await screen.findByRole("button", { name: "Mac mini 1" });
      const restore = layOutTabs();
      try {
        // Onto MacBook Air's middle (250 px), whether the dragged pill is measured whole or as a point.
        await dragTab("Mac mini 1", 240);
      } finally {
        restore();
      }
      await waitFor(() => expect(state.moved).toEqual([["term_1", "term_3"]]));
      expect(shownTabs()).toEqual(["Mac mini 2", "MacBook Air", "Mac mini 1"]);
      // The drop is no click: the selection stays where it was.
      expect(screen.getByRole("button", { name: "Mac mini 1" }).getAttribute("aria-pressed")).toBe("true");
    });

    it("leaves the order alone for a press that does not move far enough to drag", async () => {
      const { state, rpc } = threeTabs();
      render(rpc);
      await screen.findByRole("button", { name: "Mac mini 1" });
      const restore = layOutTabs();
      try {
        await dragTab("Mac mini 1", 4);
      } finally {
        restore();
      }
      expect(state.moved).toEqual([]);
      expect(shownTabs()).toEqual(["Mac mini 1", "Mac mini 2", "MacBook Air"]);
    });

    it("shows the order another window moved the tabs into", async () => {
      const { state, rpc } = threeTabs();
      const view = render(rpc);
      await screen.findByRole("button", { name: "Mac mini 1" });
      state.tabs = [state.tabs[2]!, state.tabs[0]!, state.tabs[1]!];
      await view.emitRealtime("tabs-changed", {});
      await waitFor(() => expect(shownTabs()).toEqual(["MacBook Air", "Mac mini 1", "Mac mini 2"]));
    });

    it("puts a moved tab back where the server has it when the move fails", async () => {
      const { state, rpc } = threeTabs();
      (rpc as unknown as { move: () => never }).move = () => {
        throw new Error("storage is full");
      };
      render(rpc);
      await screen.findByRole("button", { name: "Mac mini 1" });
      const restore = layOutTabs();
      try {
        // Onto MacBook Air's middle (250 px), whether the dragged pill is measured whole or as a point.
        await dragTab("Mac mini 1", 240);
      } finally {
        restore();
      }
      expect(await screen.findByText(/Could not move the terminal: storage is full/)).toBeTruthy();
      await waitFor(() => expect(shownTabs()).toEqual(["Mac mini 1", "Mac mini 2", "MacBook Air"]));
      expect(state.tabs.map((entry) => entry.terminalId)).toEqual(["term_1", "term_2", "term_3"]);
    });

    it("closes the other tabs from a tab's context menu and shows that tab", async () => {
      const { state, rpc } = threeTabs();
      windowSelection.set("term_3");
      render(rpc);
      fireEvent.contextMenu(await screen.findByRole("button", { name: "Mac mini 2" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Close other tabs" }));
      await waitFor(() => expect([...state.closed].sort()).toEqual(["term_1", "term_3"]));
      await waitFor(() => expect(shownTabs()).toEqual(["Mac mini"]));
      expect(screen.getByRole("button", { name: "Mac mini" }).getAttribute("aria-pressed")).toBe("true");
      expect(windowSelection.get()).toBe("term_2");
    });

    it("closes the tabs to the right of a tab from its context menu", async () => {
      const { state, rpc } = threeTabs();
      windowSelection.set("term_3");
      render(rpc);
      fireEvent.contextMenu(await screen.findByRole("button", { name: "Mac mini 1" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Close tabs to the right" }));
      await waitFor(() => expect([...state.closed].sort()).toEqual(["term_2", "term_3"]));
      await waitFor(() => expect(shownTabs()).toEqual(["Mac mini"]));
      expect(windowSelection.get()).toBe("term_1");
    });

    it("offers nothing to close to the right of the last tab", async () => {
      const { rpc } = threeTabs();
      render(rpc);
      fireEvent.contextMenu(await screen.findByRole("button", { name: "MacBook Air" }));
      const item = await screen.findByRole("menuitem", { name: "Close tabs to the right" });
      expect(item.getAttribute("aria-disabled")).toBe("true");
    });

    it("says in the tab when its machine is offline or its shell has ended", async () => {
      const { rpc } = threeTabs();
      render(rpc);
      await screen.findByRole("button", { name: "Mac mini 1" });
      act(() => terminals.setStatus("term_2", { state: "offline", exitCode: null }));
      act(() => terminals.setStatus("term_3", { state: "ended", exitCode: 0 }));
      // bb's pill sets the status apart by a margin, not a space.
      expect(await screen.findByRole("button", { name: "Mac mini 2(offline)" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "MacBook Air(ended)" })).toBeTruthy();
    });

    it("closes a tab on a middle click", async () => {
      const { state, rpc } = threeTabs();
      render(rpc);
      const second = await screen.findByRole("button", { name: "Mac mini 2" });
      fireEvent(second, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
      await waitFor(() => expect(state.closed).toEqual(["term_2"]));
    });
  });

  describe("a selection in the terminal", () => {
    /** A drag in the shown terminal from one point to another, with `text` selected when it lets go. */
    async function drag(terminalId: string, text: string, from = { x: 40, y: 40 }, to = { x: 120, y: 80 }) {
      const view = document.querySelector("[data-terminal-view]") as HTMLElement;
      fireEvent.pointerDown(view, { button: 0, clientX: from.x, clientY: from.y, pointerType: "mouse" });
      act(() => terminals.setSelection(terminalId, text));
      fireEvent.pointerUp(document, { button: 0, clientX: to.x, clientY: to.y, pointerType: "mouse" });
      // The page reads the selection a frame after the release, once xterm has settled it.
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      });
    }

    function thread(id: string, title: string, projectId: string, updatedAt: number, extra: Record<string, unknown> = {}) {
      return {
        id,
        projectId,
        title,
        titleFallback: null,
        displayTitle: title,
        isArchived: false,
        isHidden: false,
        updatedAt,
        environment: null,
        host: null,
        ...extra,
      };
    }

    const sidebarThreads = {
      status: "ready" as const,
      projects: [
        { id: "proj_personal", name: "Personal", isPersonal: true, href: "", settingsHref: "" },
        { id: "proj_app", name: "app", isPersonal: false, href: "", settingsHref: "" },
        { id: "proj_site", name: "site", isPersonal: false, href: "", settingsHref: "" },
      ],
      threads: [
        thread("thr_old", "Fix the login form", "proj_site", 1),
        thread("thr_new", "Speed up the build", "proj_app", 3),
        thread("thr_archived", "Old idea", "proj_app", 5, { isArchived: true, archivedAt: 5 }),
        thread("thr_hidden", "Helper", "proj_app", 4, { isHidden: true }),
      ],
    } as unknown as Host["sidebarThreads"];

    async function shownTerminal(host: Host = {}) {
      const { rpc } = server([{ id: "mini", name: "Mac mini" }], [{ ...tab("term_1", "mini", "Mac mini"), name: "build" }]);
      // The same object, so a test can change what bb answers later.
      host.sidebarThreads ??= sidebarThreads;
      const view = render(rpc, host);
      await screen.findByRole("button", { name: "build" });
      await waitFor(() => expect(document.querySelector("[data-terminal-view]")).not.toBeNull());
      return view;
    }

    it("floats Add to chat by the pointer and copies the text, with bb's toast", async () => {
      const view = await shownTerminal();
      await drag("term_1", "$ npm test\nok");
      const button = await screen.findByRole("button", { name: "Add to chat" });
      const menu = button.parentElement as HTMLElement;
      // Dragged downwards: below the pointer, as bb places it.
      expect(menu.style.transform).toBe("translateX(-50%)");
      await waitFor(() => expect(view.experimental_clipboardWrites).toEqual([{ text: "$ npm test\nok" }]));
      expect(toasts.success).toEqual(["Selection copied"]);
    });

    it("puts the button above the pointer after a drag upwards", async () => {
      await shownTerminal();
      await drag("term_1", "ok", { x: 120, y: 80 }, { x: 40, y: 40 });
      const button = await screen.findByRole("button", { name: "Add to chat" });
      expect((button.parentElement as HTMLElement).style.transform).toBe("translate(-50%, -100%)");
    });

    it("copies nothing when bb's Copy on select is off, and still offers Add to chat", async () => {
      const view = await shownTerminal({ copyOnSelect: false });
      await drag("term_1", "ok");
      expect(await screen.findByRole("button", { name: "Add to chat" })).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(view.experimental_clipboardWrites).toEqual([]);
      expect(toasts.success).toEqual([]);
    });

    it("reads the setting again as a selection starts, so a change in Settings counts", async () => {
      const host: Host = { copyOnSelect: false, configReads: { count: 0 } };
      const view = await shownTerminal(host);
      await waitFor(() => expect(host.configReads!.count).toBeGreaterThan(0));
      host.copyOnSelect = true;
      // Past the few seconds a read stays fresh.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2_100));
      });
      await drag("term_1", "ok");
      await waitFor(() => expect(view.experimental_clipboardWrites).toEqual([{ text: "ok" }]));
    });

    it("reads the setting again at once when bb says its settings were saved", async () => {
      const host: Host = { copyOnSelect: true, configReads: { count: 0 } };
      const view = await shownTerminal(host);
      await waitFor(() => expect(host.configReads!.count).toBeGreaterThan(0));
      await waitFor(() => expect(host.configChanged?.size).toBe(1));
      const before = host.configReads!.count;
      host.copyOnSelect = false;
      // Well inside the few seconds a read stays fresh: the event does not wait for them.
      act(() => {
        for (const listener of host.configChanged!) listener();
      });
      await waitFor(() => expect(host.configReads!.count).toBe(before + 1));
      await drag("term_1", "ok");
      expect(await screen.findByRole("button", { name: "Add to chat" })).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(view.experimental_clipboardWrites).toEqual([]);
    });

    it("does nothing for a selection the user did not make", async () => {
      const view = await shownTerminal();
      act(() => terminals.setSelection("term_1", "printed by a program"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull();
      expect(view.experimental_clipboardWrites).toEqual([]);
    });

    it("offers nothing for an empty selection, and takes the button away when the selection goes or the view scrolls", async () => {
      const view = await shownTerminal();
      await drag("term_1", "   ");
      expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull();
      expect(view.experimental_clipboardWrites).toEqual([]);

      await drag("term_1", "ok");
      await screen.findByRole("button", { name: "Add to chat" });
      act(() => terminals.setSelection("term_1", ""));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull());

      await drag("term_1", "ok");
      await screen.findByRole("button", { name: "Add to chat" });
      act(() => terminals.scroll("term_1"));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull());
    });

    it("does not copy the same selection twice when the mouse lets go over it again", async () => {
      const view = await shownTerminal();
      await drag("term_1", "ok");
      await waitFor(() => expect(view.experimental_clipboardWrites).toHaveLength(1));
      await drag("term_1", "ok");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(view.experimental_clipboardWrites).toHaveLength(1);
    });

    it("lists open threads, most recent first with their projects, and searches them", async () => {
      await shownTerminal();
      await drag("term_1", "ok");
      fireEvent.click(await screen.findByRole("button", { name: "Add to chat" }));
      const list = await screen.findByRole("listbox", { name: "Threads" });
      const rows = within(list).getAllByRole("option").map((row) => row.textContent);
      expect(rows).toEqual(["New thread", "Speed up the buildapp", "Fix the login formsite"]);
      expect(screen.getByText(/1 line from build on Mac mini/)).toBeTruthy();

      fireEvent.change(screen.getByRole("combobox", { name: "Search threads" }), { target: { value: "site" } });
      expect(within(list).getAllByRole("option").map((row) => row.textContent)).toEqual(["New thread", "Fix the login formsite"]);
      fireEvent.change(screen.getByRole("combobox", { name: "Search threads" }), { target: { value: "nothing like it" } });
      expect(screen.getByText(/No thread matches/)).toBeTruthy();
    });

    it("sends the selection to the chosen thread's composer, as a fenced block saying where it came from", async () => {
      const view = await shownTerminal();
      await drag("term_1", "$ npm test\nok");
      fireEvent.click(await screen.findByRole("button", { name: "Add to chat" }));
      fireEvent.click(await screen.findByRole("option", { name: /Fix the login form/ }));
      await waitFor(() => expect(view.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_old" }));
      expect(windowDeliveries.get()).toMatchObject({
        target: { kind: "thread", threadId: "thr_old" },
        block: "Terminal output from build on Mac mini:\n\n```text\n$ npm test\nok\n```",
      });
      // Nothing is sent for the user.
      expect(view.sdkCalls.filter((call) => String(call).includes("send"))).toEqual([]);
      expect(screen.queryByRole("listbox", { name: "Threads" })).toBeNull();
    });

    it("picks a thread with the keyboard from the search field", async () => {
      const view = await shownTerminal();
      await drag("term_1", "ok");
      fireEvent.click(await screen.findByRole("button", { name: "Add to chat" }));
      const search = await screen.findByRole("combobox", { name: "Search threads" });
      fireEvent.keyDown(search, { key: "ArrowDown" });
      fireEvent.keyDown(search, { key: "Enter" });
      await waitFor(() => expect(view.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_new" }));
    });

    it("keeps the row the keys move to in sight, scrolling only the list", async () => {
      const many = {
        ...(sidebarThreads as object),
        threads: Array.from({ length: 12 }, (_, index) => thread(`thr_${index}`, `Thread ${index}`, "proj_app", 100 - index)),
      } as unknown as Host["sidebarThreads"];
      const view = await shownTerminal({ sidebarThreads: many });
      await drag("term_1", "ok");
      fireEvent.click(await screen.findByRole("button", { name: "Add to chat" }));
      const search = await screen.findByRole("combobox", { name: "Search threads" });
      const list = screen.getByRole("listbox", { name: "Threads" });
      const rows = within(list).getAllByRole("option");
      // jsdom lays nothing out: rows 30 px tall in a list that shows three of them.
      const ROW = 30;
      const SHOWN = 3;
      list.getBoundingClientRect = () => new DOMRect(0, 100, 300, ROW * SHOWN);
      rows.forEach((row, index) => {
        row.getBoundingClientRect = () => new DOMRect(0, 100 + index * ROW - list.scrollTop, 300, ROW);
      });
      const outer = list.parentElement as HTMLElement;
      outer.scrollTop = 0;

      for (let step = 0; step < 5; step += 1) fireEvent.keyDown(search, { key: "ArrowDown" });
      // Row 5 is the active one, named on the search field, and the list scrolled to show it whole.
      expect(search.getAttribute("aria-activedescendant")).toBe(rows[5]!.id);
      expect(rows[5]!.getAttribute("aria-selected")).toBe("true");
      expect(list.scrollTop).toBe((5 + 1 - SHOWN) * ROW);
      expect(outer.scrollTop).toBe(0);

      for (let step = 0; step < 4; step += 1) fireEvent.keyDown(search, { key: "ArrowUp" });
      expect(search.getAttribute("aria-activedescendant")).toBe(rows[1]!.id);
      expect(list.scrollTop).toBe(1 * ROW);

      fireEvent.keyDown(search, { key: "Enter" });
      await waitFor(() => expect(view.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_0" }));
    });

    it("starts a new thread in the project whose checkout holds the shell's directory", async () => {
      const view = await shownTerminal({
        projects: [
          { id: "proj_app", sources: [{ hostId: "mini", path: "/Users/me/code/app" }] },
          { id: "proj_site", sources: [{ hostId: "mini", path: "/Users/me/code/site" }] },
        ],
      });
      terminals.entry("term_1").cwd = "/Users/me/code/site/src";
      await drag("term_1", "ok");
      fireEvent.click(await screen.findByRole("button", { name: "Add to chat" }));
      await screen.findByRole("button", { name: "Project: site" });
      fireEvent.click(screen.getByRole("option", { name: /New thread/ }));
      await waitFor(() =>
        expect(view.navigateCalls).toContainEqual({ method: "toCompose", options: { projectId: "proj_site", focusPrompt: true } }),
      );
      expect(windowDeliveries.get()?.target).toEqual({ kind: "new-thread", projectId: "proj_site" });
    });

    it("starts a new thread in the last project picked when the shell has not said where it is", async () => {
      window.localStorage.setItem("bb-plugin-terminals:last-new-thread-project", "proj_personal");
      await shownTerminal();
      await drag("term_1", "ok");
      fireEvent.click(await screen.findByRole("button", { name: "Add to chat" }));
      expect(await screen.findByRole("button", { name: "Project: Personal" })).toBeTruthy();
      window.localStorage.removeItem("bb-plugin-terminals:last-new-thread-project");
    });
  });
});
