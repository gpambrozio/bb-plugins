// @vitest-environment jsdom
/**
 * The header button and its menu against a fake server: the actions, each state of the file, and
 * what picking an action asks of the server and of bb's terminal panel.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { RpcContract } from "../shared/contract";
import { FORMAT_URL, type ActionsList, type RunOutcome } from "../shared/views";
import { ActionsHeaderButton, type HeaderActionProps } from "./actions-menu";
import { EDITOR_TAB } from "./tabs";

const toasts = vi.hoisted(() => ({ error: [] as { message: string; description?: string }[] }));
vi.mock("sonner", () => ({
  toast: { error: (message: string, options?: { description?: string }) => void toasts.error.push({ message, description: options?.description }) },
}));

beforeAll(() => {
  // jsdom has neither; bb's menu and its compact-viewport hook ask them.
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
  toasts.error.length = 0;
});

afterEach(() => cleanup());

const READY: ActionsList = {
  state: "ready",
  actions: [
    { name: "Dev server", command: "npm run dev", cwd: null, description: "Vite on :5173", status: "running" },
    { name: "Run tests", command: "npm test", cwd: "web", description: null, status: "idle" },
    { name: "Lint", command: "npm run lint", cwd: null, description: null, status: "finished" },
  ],
};

function render(options: { list?: () => Promise<ActionsList>; run?: (input: { threadId: string; name: string }) => Promise<RunOutcome>; openTerminal?: () => boolean } = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const rpc: PluginRpcTestHandlers<RpcContract> = {
    list: async (input) => {
      calls.push({ method: "list", input });
      return (options.list ?? (async () => READY))();
    },
    run: async (input) => {
      calls.push({ method: "run", input });
      return (options.run ?? (async () => ({ terminalId: "term_1", outcome: "started" as const })))(input);
    },
    read: async () => ({ state: "unavailable", message: "not used here" }),
    save: async () => ({ outcome: "conflict" }),
  };
  const rendered = renderSlot<HeaderActionProps, RpcContract>(
    { component: ActionsHeaderButton },
    { threadId: "thr_1", projectId: "proj_1", isCompactViewport: false },
    { rpc, openTerminal: options.openTerminal ?? (() => true), experimental_panel: { openTab: () => true } },
  );
  return { calls, rendered };
}

async function openMenu() {
  const button = screen.getByRole("button", { name: "Project actions" });
  fireEvent.pointerDown(button, { button: 0, ctrlKey: false, pointerType: "mouse" });
  return screen.findByRole("menu");
}

describe("the Project actions menu", () => {
  it("reads the thread's actions when it opens, and shows each with how its last run stands", async () => {
    const { calls } = render();
    expect(calls).toEqual([]);
    const menu = await openMenu();
    const items = await within(menu).findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Dev serverVite on :5173Running", "Run testsnpm test", "Lintnpm run lintFinished", "Edit actions…"]);
    expect(calls).toEqual([{ method: "list", input: { threadId: "thr_1" } }]);
  });

  it("runs a picked action and shows its terminal in bb's terminal panel", async () => {
    const { calls, rendered } = render({ run: async () => ({ terminalId: "term_9", outcome: "started" }) });
    const menu = await openMenu();
    fireEvent.click(await within(menu).findByRole("menuitem", { name: /Run tests/ }));
    await waitFor(() => expect(rendered.inspection.navigateCalls).toEqual([{ method: "experimental_openTerminal", options: { terminalId: "term_9" } }]));
    expect(calls.at(-1)).toEqual({ method: "run", input: { threadId: "thr_1", name: "Run tests" } });
    expect(toasts.error).toEqual([]);
  });

  it("says why an action did not start", async () => {
    render({
      run: async () => {
        throw new Error("This thread's workspace is gone.");
      },
    });
    const menu = await openMenu();
    fireEvent.click(await within(menu).findByRole("menuitem", { name: /Run tests/ }));
    await waitFor(() => expect(toasts.error).toEqual([{ message: '"Run tests" did not start', description: "This thread's workspace is gone." }]));
  });

  it("says when bb would not show the terminal", async () => {
    render({ openTerminal: () => false });
    const menu = await openMenu();
    fireEvent.click(await within(menu).findByRole("menuitem", { name: /Lint/ }));
    await waitFor(() => expect(toasts.error[0]?.message).toMatch(/bb could not show its terminal/));
  });

  it("explains how to add actions when the project has no actions file", async () => {
    const { rendered } = render({ list: async () => ({ state: "missing" }) });
    const menu = await openMenu();
    expect(await within(menu).findByText("No actions in this project")).toBeTruthy();
    expect(within(menu).getByText(".bb/actions.json")).toBeTruthy();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /How to write the actions file/ }));
    expect(rendered.inspection.navigateCalls).toEqual([{ method: "openUrl", url: FORMAT_URL }]);
  });

  it("opens the editor beside the thread from Add actions", async () => {
    const { rendered } = render({ list: async () => ({ state: "missing" }) });
    const menu = await openMenu();
    fireEvent.click(await within(menu).findByRole("menuitem", { name: /Add actions/ }));
    expect(rendered.inspection.experimental_panelCalls).toEqual([{ method: "openTab", options: { tab: EDITOR_TAB } }]);
  });

  it("opens the editor from Edit actions… under the list, and from a file with a problem", async () => {
    const { rendered } = render();
    const menu = await openMenu();
    fireEvent.click(await within(menu).findByRole("menuitem", { name: "Edit actions…" }));
    expect(rendered.inspection.experimental_panelCalls).toEqual([{ method: "openTab", options: { tab: EDITOR_TAB } }]);
    cleanup();
    const broken = render({ list: async () => ({ state: "invalid", problem: { message: "Expected a comma", line: 2, column: 3, path: null } }) });
    fireEvent.click(await within(await openMenu()).findByRole("menuitem", { name: /Fix it in the editor/ }));
    expect(broken.rendered.inspection.experimental_panelCalls).toEqual([{ method: "openTab", options: { tab: EDITOR_TAB } }]);
  });

  it("shows a problem in the file and where it is, and reads it again on Try again", async () => {
    let answer: ActionsList = { state: "invalid", problem: { message: 'Missing "command"', line: 3, column: 5, path: "actions[0]" } };
    const { calls } = render({ list: async () => answer });
    const menu = await openMenu();
    expect(await within(menu).findByText('Missing "command"')).toBeTruthy();
    expect(within(menu).getByText(".bb/actions.json, line 3, column 5 (actions[0])")).toBeTruthy();
    answer = READY;
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: /Try again/ }));
    });
    expect(await within(screen.getByRole("menu")).findByRole("menuitem", { name: /Dev server/ })).toBeTruthy();
    expect(calls.filter((call) => call.method === "list")).toHaveLength(2);
  });

  it("says why the actions could not be read", async () => {
    render({ list: async () => ({ state: "unavailable", message: "MacBook Air is offline, so its workspace cannot be read." }) });
    const menu = await openMenu();
    expect(await within(menu).findByText("MacBook Air is offline, so its workspace cannot be read.")).toBeTruthy();
  });

  it("says when the server could not be asked", async () => {
    render({
      list: async () => {
        throw new Error("Plugin is reloading");
      },
    });
    const menu = await openMenu();
    expect(await within(menu).findByText("Plugin is reloading")).toBeTruthy();
  });

  it("points at the file when it lists no actions", async () => {
    render({ list: async () => ({ state: "ready", actions: [] }) });
    const menu = await openMenu();
    expect(await within(menu).findByText("No actions yet")).toBeTruthy();
  });
});
