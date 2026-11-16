/**
 * The app's registrations, run against a stub builder (`loadPluginApp` does not capture commands): the debug
 * log is a side-panel tab, and the palette command and the first mate's header entry open it through bb's
 * panel controller.
 */
import { afterEach, describe, expect, it } from "vitest";

import { debugOpen } from "./debug-view";

interface Registered {
  tabs: Record<string, unknown>[];
  commands: { id: string; title: string; run(context: unknown): void }[];
  threadActions: { id: string; item(input: unknown): { label: string; run(context: unknown): void } | null }[];
  composer: { id: string; scopes?: string[]; actions?: { id: string }[] }[];
}

async function setUp(): Promise<Registered> {
  const registered: Registered = { tabs: [], commands: [], threadActions: [], composer: [] };
  const definition = (await import("../app")).default as unknown as { setup(builder: unknown): void };
  const slots = new Proxy({} as Record<string, unknown>, {
    get: (_target, name) =>
      name === "experimental_tab"
        ? (tab: Record<string, unknown>) => registered.tabs.push(tab)
        : name === "experimental_threadAction"
          ? (action: Registered["threadActions"][number]) => registered.threadActions.push(action)
          : () => undefined,
  });
  definition.setup({
    slots,
    commands: { register: (command: Registered["commands"][number]) => registered.commands.push(command) },
    composer: { customize: (customization: Registered["composer"][number]) => registered.composer.push(customization) },
  });
  return registered;
}

const TAB = { id: "debug", context: { kind: "thread" }, availability: "action" };

function panel(accepts: boolean) {
  const calls: unknown[] = [];
  return { calls, openTab: (options: unknown) => (calls.push(options), accepts) };
}

afterEach(() => debugOpen.done());

describe("the debug log's side panel", () => {
  it("registers the debug log as a thread side-panel tab, and an opener in each thread's composer", async () => {
    const { tabs, composer } = await setUp();
    expect(tabs.map((tab) => [tab.id, tab.context, tab.availability, tab.title, tab.icon, tab.layout])).toEqual([
      ["debug", { kind: "thread" }, "action", "Voice debug", "Bug", "flush"],
    ]);
    expect(composer).toEqual([expect.objectContaining({ id: "debug-opener", scopes: ["thread"], actions: [expect.objectContaining({ id: "debug-opener" })] })]);
  });

  it("opens the tab from the palette through the focused surface's panel", async () => {
    const { commands } = await setUp();
    const command = commands.find((item) => item.id === "debug")!;
    expect(command.title).toBe("FirstMate voice: debug log");
    const focused = panel(true);
    command.run({ threadId: "thr_1", projectId: null, experimental_panel: focused });
    expect(focused.calls).toEqual([{ tab: TAB }]);
    expect(debugOpen.wanted).toBeNull();
  });

  it("from a surface with no thread panel, asks for the first mate's thread instead", async () => {
    const { commands } = await setUp();
    commands.find((item) => item.id === "debug")!.run({ threadId: null, projectId: null, experimental_panel: panel(false) });
    expect(debugOpen.wanted?.threadId).toBeNull();
  });

  it("opens the tab from the first mate's header menu, and offers it on no other thread", async () => {
    const { threadActions } = await setUp();
    const action = threadActions.find((item) => item.id === "debug")!;
    expect(action.item({ thread: { id: "thr_other" }, data: { mate: "thr_mate" }, experimental_panel: panel(true) })).toBeNull();
    const focused = panel(true);
    const entry = action.item({ thread: { id: "thr_mate" }, data: { mate: "thr_mate" }, experimental_panel: focused })!;
    expect(entry.label).toBe("Voice debug log");
    entry.run({});
    expect(focused.calls).toEqual([{ tab: TAB }]);
    const declining = action.item({ thread: { id: "thr_mate" }, data: { mate: "thr_mate" }, experimental_panel: panel(false) })!;
    declining.run({});
    expect(debugOpen.wanted?.threadId).toBe("thr_mate");
  });
});
