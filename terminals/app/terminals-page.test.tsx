// @vitest-environment jsdom
/**
 * The page against a fake server: "+" opens straight away with one machine
 * and asks with several, tabs close, and an ended shell says so. The
 * terminals themselves (xterm and bb's socket) are replaced by a stub whose
 * status the test sets.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { RpcContract } from "../shared/contract";
import type { HostChoice, TabView } from "../shared/tabs";
import type { ConnectionStatus } from "./connection";

const terminals = vi.hoisted(() => {
  type Listener = (status: ConnectionStatus) => void;
  const entries = new Map<string, { status: ConnectionStatus; listeners: Set<Listener>; attached: number }>();
  function entry(terminalId: string) {
    let found = entries.get(terminalId);
    if (found === undefined) {
      found = { status: { state: "live", exitCode: null }, listeners: new Set(), attached: 0 };
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
  };
});

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
    };
  },
  releaseClosedTerminals: (open: ReadonlySet<string>) => {
    for (const id of [...terminals.entries.keys()]) if (!open.has(id)) terminals.entries.delete(id);
  },
  applyThemeToAll: () => undefined,
}));

const { TerminalsPage } = await import("./terminals-page");
const { windowSelection } = await import("./selection");

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
});

afterEach(() => cleanup());

function tab(terminalId: string, hostId: string, hostName: string): TabView {
  return { terminalId, hostId, hostName, createdAt: 0, name: null, status: "running", exitCode: null };
}

/** A fake server holding a tab list, with the given machines connected. */
function server(hosts: HostChoice[], initial: TabView[] = []) {
  const state = { tabs: [...initial], opened: [] as string[], closed: [] as string[], renamed: [] as [string, string | null][] };
  let next = initial.length + 1;
  const rpc = {
    hosts: () => ({ hosts }),
    list: () => ({ tabs: state.tabs }),
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
    close: ({ terminalId }: { terminalId: string }) => {
      state.tabs = state.tabs.filter((entry) => entry.terminalId !== terminalId);
      state.closed.push(terminalId);
      return {};
    },
  } as unknown as PluginRpcTestHandlers<RpcContract>;
  return { state, rpc };
}

function render(rpc: PluginRpcTestHandlers<RpcContract>) {
  return renderSlot<PluginNavPanelProps, RpcContract>({ component: TerminalsPage }, { subPath: "" }, { rpc });
}

function pressPlus() {
  const plus = within(screen.getByRole("tablist")).getByRole("button", { name: "New terminal" });
  fireEvent.pointerDown(plus, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("the Terminals page", () => {
  it("starts empty, and + opens a terminal on the only machine without asking", async () => {
    const { state, rpc } = server([{ id: "mini", name: "Mac mini" }]);
    render(rpc);
    expect(await screen.findByText(/No terminals open/)).toBeTruthy();
    pressPlus();
    expect(await screen.findByRole("tab", { name: /Mac mini/ })).toBeTruthy();
    expect(state.opened).toEqual(["mini"]);
    expect(screen.queryByText("Open a terminal on")).toBeNull();
    expect(screen.getByRole("tab", { name: /Mac mini/ }).getAttribute("aria-selected")).toBe("true");
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
    expect(await screen.findByRole("tab", { name: /MacBook Air/ })).toBeTruthy();
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
    const second = await screen.findByRole("tab", { name: "Mac mini 2" });
    expect(second.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close Mac mini 2" }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: /Mac mini 2/ })).toBeNull());
    expect(state.closed).toEqual(["term_2"]);
    expect(screen.getByRole("tab", { name: "MacBook Air" }).getAttribute("aria-selected")).toBe("true");
    // One Mac mini tab left, so it is no longer numbered.
    expect(screen.getByRole("tab", { name: "Mac mini" })).toBeTruthy();
  });

  it("marks only the selected tab, the way bb marks its own, and moves the mark with the selection", async () => {
    const { rpc } = server(
      [{ id: "mini", name: "Mac mini" }],
      [tab("term_1", "mini", "Mac mini"), tab("term_2", "mini", "Mac mini")],
    );
    windowSelection.set("term_1");
    render(rpc);
    const first = await screen.findByRole("tab", { name: "Mac mini 1" });
    const second = screen.getByRole("tab", { name: "Mac mini 2" });
    // The tab's frame is the element around its button and its close button.
    const frame = (button: HTMLElement) => button.parentElement as HTMLElement;
    const marked = (button: HTMLElement) => frame(button).querySelector("[data-tab-indicator]") !== null;

    // bb's "active" fill and full-strength text, against dimmer text on the others; the
    // old fill (bg-sidebar) was all but the page's own background in dark mode.
    expect(frame(first).className).toMatch(/\bbg-state-active\b/);
    expect(frame(first).className).toMatch(/\btext-foreground\b/);
    expect(frame(first).className).not.toMatch(/\bbg-sidebar\b/);
    expect(frame(second).className).not.toMatch(/\bbg-state-active\b/);
    expect(frame(second).className).toMatch(/\btext-subtle-foreground\b/);
    expect([marked(first), marked(second)]).toEqual([true, false]);

    fireEvent.click(second);
    await waitFor(() => expect(second.getAttribute("aria-selected")).toBe("true"));
    expect([marked(first), marked(second)]).toEqual([false, true]);
    expect(frame(second).className).toMatch(/\bbg-state-active\b/);
    expect(frame(first).className).not.toMatch(/\bbg-state-active\b/);  });

  it("says when a shell has ended and offers to close its tab", async () => {
    const { state, rpc } = server([{ id: "mini", name: "Mac mini" }], [tab("term_1", "mini", "Mac mini")]);
    render(rpc);
    await screen.findByRole("tab", { name: "Mac mini" });
    act(() => terminals.setStatus("term_1", { state: "ended", exitCode: 130 }));
    expect(await screen.findByText("This shell exited with code 130.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    await waitFor(() => expect(state.closed).toEqual(["term_1"]));
    expect(await screen.findByText(/No terminals open/)).toBeTruthy();
  });

  it("says when a machine is offline", async () => {
    const { rpc } = server([{ id: "mini", name: "Mac mini" }], [tab("term_1", "mini", "Mac mini")]);
    render(rpc);
    await screen.findByRole("tab", { name: "Mac mini" });
    act(() => terminals.setStatus("term_1", { state: "offline", exitCode: null }));
    expect(await screen.findByText(/This machine is offline/)).toBeTruthy();
  });

  describe("renaming a tab", () => {
    const twoTabs = () =>
      server([{ id: "mini", name: "Mac mini" }], [tab("term_1", "mini", "Mac mini"), tab("term_2", "mini", "Mac mini")]);

    async function editByDoubleClick(name: string) {
      fireEvent.doubleClick(await screen.findByRole("tab", { name }));
      return (await screen.findByRole("textbox", { name: `Rename ${name}` })) as HTMLInputElement;
    }

    it("edits the title in place on a double click; Enter saves it for every client", async () => {
      const { state, rpc } = twoTabs();
      render(rpc);
      const input = await editByDoubleClick("Mac mini 2");
      expect(input.value).toBe("Mac mini 2");
      fireEvent.change(input, { target: { value: "  dev server " } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(await screen.findByRole("tab", { name: "dev server" })).toBeTruthy();
      expect(state.renamed).toEqual([["term_2", "dev server"]]);
      // The other tab keeps its number.
      expect(screen.getByRole("tab", { name: "Mac mini 1" })).toBeTruthy();
    });

    it("keeps the old title on Escape", async () => {
      const { state, rpc } = twoTabs();
      render(rpc);
      const input = await editByDoubleClick("Mac mini 1");
      fireEvent.change(input, { target: { value: "scratch" } });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(await screen.findByRole("tab", { name: "Mac mini 1" })).toBeTruthy();
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
      expect(await screen.findByRole("tab", { name: "Mac mini" })).toBeTruthy();
      expect(state.renamed).toEqual([["term_1", null]]);
    });

    it("saves when the field loses focus, and sends nothing for an untouched default title", async () => {
      const { state, rpc } = twoTabs();
      render(rpc);
      let input = await editByDoubleClick("Mac mini 1");
      fireEvent.blur(input);
      await screen.findByRole("tab", { name: "Mac mini 1" });
      expect(state.renamed).toEqual([]);
      input = await editByDoubleClick("Mac mini 1");
      fireEvent.change(input, { target: { value: "build" } });
      fireEvent.blur(input);
      expect(await screen.findByRole("tab", { name: "build" })).toBeTruthy();
      expect(state.renamed).toEqual([["term_1", "build"]]);
    });

    it("renames from the tab's context menu and with F2", async () => {
      const { state, rpc } = twoTabs();
      render(rpc);
      fireEvent.contextMenu(await screen.findByRole("tab", { name: "Mac mini 1" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: /Rename/ }));
      let input = (await screen.findByRole("textbox", { name: "Rename Mac mini 1" })) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "one" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await screen.findByRole("tab", { name: "one" });
      fireEvent.keyDown(screen.getByRole("tab", { name: "Mac mini 2" }), { key: "F2" });
      input = (await screen.findByRole("textbox", { name: "Rename Mac mini 2" })) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "two" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await screen.findByRole("tab", { name: "two" });
      expect(state.renamed).toEqual([
        ["term_1", "one"],
        ["term_2", "two"],
      ]);
    });

    it("closes a tab from its context menu", async () => {
      const { state, rpc } = twoTabs();
      render(rpc);
      fireEvent.contextMenu(await screen.findByRole("tab", { name: "Mac mini 2" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: /Close tab/ }));
      await waitFor(() => expect(state.closed).toEqual(["term_2"]));
    });

    it("shows a name another client gave", async () => {
      const { rpc } = server([{ id: "mini", name: "Mac mini" }], [{ ...tab("term_1", "mini", "Mac mini"), name: "deploy" }]);
      render(rpc);
      const named = await screen.findByRole("tab", { name: "deploy" });
      expect(named.getAttribute("title")).toBe("deploy — Mac mini");
    });
  });
});
