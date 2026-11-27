/**
 * The app's registrations, run against a stub builder (`loadPluginApp` does not capture commands): the debug
 * log is a side-panel tab, the palette command and every thread's header menu open it through bb's panel
 * controller, Talk is in every thread's header, and the Voice page is in the sidebar.
 */
import { afterEach, describe, expect, it } from "vitest";

import { debugOpen } from "./debug-view";

interface Registered {
  tabs: Record<string, unknown>[];
  commands: { id: string; title: string; run(context: unknown): void }[];
  threadActions: { id: string; item(input: unknown): { label: string; run(context: unknown): void } | null }[];
  composer: { id: string; scopes?: string[]; actions?: { id: string }[] }[];
  settings: { id: string; title: string }[];
  navPanels: { id: string; title: string; icon: string; path: string; experimental_useBadge?: unknown }[];
}

async function setUp(): Promise<Registered> {
  const registered: Registered = { tabs: [], commands: [], threadActions: [], composer: [], settings: [], navPanels: [] };
  const definition = (await import("../app")).default as unknown as { setup(builder: unknown): void };
  const slots = new Proxy({} as Record<string, unknown>, {
    get: (_target, name) =>
      name === "experimental_tab"
        ? (tab: Record<string, unknown>) => registered.tabs.push(tab)
        : name === "experimental_threadAction"
          ? (action: Registered["threadActions"][number]) => registered.threadActions.push(action)
          : name === "settingsSection"
            ? (section: Registered["settings"][number]) => registered.settings.push(section)
            : name === "navPanel"
              ? (panel: Registered["navPanels"][number]) => registered.navPanels.push(panel)
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
    expect(command.title).toBe("Voice Pilot: debug log");
    const focused = panel(true);
    command.run({ threadId: "thr_1", projectId: null, experimental_panel: focused });
    expect(focused.calls).toEqual([{ tab: TAB }]);
    expect(debugOpen.wanted).toBeNull();
  });

  it("from a surface with no thread panel, asks for the Voice page instead", async () => {
    const { commands } = await setUp();
    commands.find((item) => item.id === "debug")!.run({ threadId: null, projectId: null, experimental_panel: panel(false) });
    expect(debugOpen.wanted?.threadId).toBeNull();
  });

  it("opens the tab from any thread's header menu, or asks that thread's view to when the surface declines", async () => {
    const { threadActions } = await setUp();
    const action = threadActions.find((item) => item.id === "debug")!;
    const focused = panel(true);
    const entry = action.item({ thread: { id: "thr_any" }, data: null, experimental_panel: focused })!;
    expect(entry.label).toBe("Voice debug log");
    entry.run({});
    expect(focused.calls).toEqual([{ tab: TAB }]);
    action.item({ thread: { id: "thr_any" }, data: null, experimental_panel: panel(false) })!.run({});
    expect(debugOpen.wanted?.threadId).toBe("thr_any");
  });
});

describe("starting and stopping", () => {
  it("is a Talk button in every thread's header, End while a session is up", async () => {
    const { threadActions } = await setUp();
    const talk = threadActions.find((item) => item.id === "talk")!;
    expect(talk.item({ thread: { id: "thr_any" }, data: { active: false } })?.label).toBe("Talk");
    expect(talk.item({ thread: { id: "thr_other" }, data: { active: true } })?.label).toBe("End voice");
  });

  it("is a palette command, and the Voice page in the sidebar with a badge while live", async () => {
    const { commands, navPanels } = await setUp();
    expect(commands.map((command) => [command.id, command.title])).toContainEqual(["talk", "Voice Pilot: talk or end"]);
    expect(navPanels).toEqual([expect.objectContaining({ id: "voice", title: "Voice", icon: "Mic", path: "voice", experimental_useBadge: expect.any(Function) })]);
  });
});

describe("the sidebar badge", () => {
  it("says Live, Paused while bb was off the phone's screen, and nothing when idle", async () => {
    const { liveBadge } = await import("../app");
    const idle = { phase: "idle" as const, muted: false, speaking: { user: false, voice: false }, note: null, opened: null };
    expect(liveBadge({ ...idle, phase: "live" })?.text).toBe("Live");
    expect(liveBadge({ ...idle, phase: "paused" })?.text).toBe("Paused");
    expect(liveBadge({ ...idle, phase: "resuming" })?.text).toBe("…");
    expect(liveBadge(idle)).toBeNull();
  });
});

describe("the voice hooks' settings", () => {
  it("are a section of the plugin's settings page", async () => {
    const { settings } = await setUp();
    expect(settings.map((section) => [section.id, section.title])).toEqual([["hooks", "Voice hooks"]]);
  });

  it("say of each machine only whether its hook file is there and runs", async () => {
    const { hookFileText } = await import("./hooks-section");
    expect(hookFileText({ present: true, executable: true })).toBe("Has ~/.config/voice-pilot/hook: it runs.");
    expect(hookFileText({ present: true, executable: false })).toMatch(/not executable \(chmod \+x\)/u);
    // A hook file with an extension is named as it is, and the ones that do not run are named too.
    expect(hookFileText({ present: true, executable: true, path: "/Users/someone/.config/voice-pilot/hook.sh" })).toBe("Has ~/.config/voice-pilot/hook.sh: it runs.");
    expect(hookFileText({ present: true, executable: true, path: "/Users/someone/.config/voice-pilot/hook", others: ["hook.sh"] })).toBe(
      "Has ~/.config/voice-pilot/hook: it runs. hook.sh is there too, and does not run: only the first hook file found runs.",
    );
    expect(hookFileText({ present: true, executable: false, path: "/h/.config/voice-pilot/hook.py", others: ["hook.js", "hook.rb"] })).toMatch(
      /^Has ~\/\.config\/voice-pilot\/hook\.py, but it is not executable .* hook\.js, hook\.rb are there too, and do not run/u,
    );
    expect(hookFileText({ present: false, executable: false })).toBe("No hook file: nothing runs.");
    expect(hookFileText(null)).toMatch(/Did not answer/u);
  });
});
