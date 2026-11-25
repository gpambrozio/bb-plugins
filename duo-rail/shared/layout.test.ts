import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUTTONS,
  DEFAULT_LAYOUT_JSON,
  defaultLayout,
  displayFor,
  joinArgs,
  layoutProblem,
  layoutSchema,
  MAX_BUTTONS,
  parseLayout,
  serializeLayout,
  splitArgs,
  type Layout,
  type RailButton,
} from "./layout";

const withFolded = (buttons: unknown[]): string => JSON.stringify({ version: 1, folded: { buttons }, unfolded: { buttons: [] } });
const back: RailButton = { id: "back", label: "Back", icon: "ArrowLeft", action: { kind: "back" } };

describe("the default layout", () => {
  it("is today's set on both displays: Back, New thread, More", () => {
    const layout = defaultLayout();
    for (const display of ["folded", "unfolded"] as const) {
      expect(layout[display].buttons.map((button) => button.label)).toEqual(["Back", "New thread", "More"]);
    }
    const more = layout.folded.buttons[2]?.action;
    expect(more?.kind === "menu" && more.items.map((item) => item.action.kind)).toEqual(["recentThreads", "forward", "reload"]);
  });

  it("is a valid layout, and the setting's default is its JSON", () => {
    expect(layoutSchema.safeParse(defaultLayout()).success).toBe(true);
    expect(JSON.parse(DEFAULT_LAYOUT_JSON)).toEqual(defaultLayout());
  });

  it("gives each display its own copy", () => {
    const layout = defaultLayout();
    layout.folded.buttons.pop();
    expect(layout.unfolded.buttons).toHaveLength(3);
    expect(DEFAULT_BUTTONS).toHaveLength(3);
  });
});

describe("parseLayout", () => {
  it.each([undefined, null, "", "   "])("reads %j as the default, with no problem", (raw) => {
    expect(parseLayout(raw)).toEqual({ layout: defaultLayout(), problem: null });
  });

  it("reads a saved layout", () => {
    const saved: Layout = { version: 1, folded: { buttons: [back] }, unfolded: { buttons: [] } };
    expect(parseLayout(serializeLayout(saved))).toEqual({ layout: saved, problem: null });
  });

  it.each<[string, unknown, string]>([
    ["text that is not JSON", "{ nope", "not valid JSON"],
    ["a value that is not text", 42, "not text"],
    ["a layout from a later version", JSON.stringify({ version: 2, folded: { buttons: [] }, unfolded: { buttons: [] } }), "version"],
  ])("falls back to the default on %s, and says why", (_, raw, reason) => {
    const parsed = parseLayout(raw);
    expect(parsed.layout).toEqual(defaultLayout());
    expect(parsed.problem).toContain(reason);
  });
});

describe("layoutProblem", () => {
  it("accepts every kind of action", () => {
    const buttons: RailButton[] = [
      back,
      { id: "f", label: "Forward", icon: "ArrowRight", action: { kind: "forward" } },
      { id: "r", label: "Reload", icon: "ArrowReloadHorizontal", action: { kind: "reload" } },
      { id: "n", label: "New", icon: "nav:new-thread", action: { kind: "newThread", projectId: "p1" } },
      { id: "t", label: "Thread", icon: "MessageSquare", action: { kind: "openThread", threadId: "t1" } },
      { id: "p", label: "Project", icon: "Folder", action: { kind: "openProject", projectId: "p1" } },
      { id: "a", label: "Pin", icon: "Pin", action: { kind: "threadAction", key: "bb--core/pin" } },
      {
        id: "m",
        label: "More",
        icon: "MoreHorizontal",
        action: {
          kind: "menu",
          items: [
            { id: "c", label: "Say hi", icon: "Mic", action: { kind: "bbCommand", args: ["herald", "say", "hi"] } },
            { id: "u", label: "Docs", icon: "Globe", action: { kind: "openUrl", url: "https://example.com" } },
            { id: "x", label: "Recent", icon: "Clock", action: { kind: "recentThreads", count: 3 } },
          ],
        },
      },
    ];
    expect(layoutProblem(withFolded(buttons))).toBeNull();
  });

  it.each<[string, unknown[]]>([
    ["a button with no name", [{ ...back, label: "  " }]],
    ["two buttons with one id", [back, back]],
    ["more buttons than fit", Array.from({ length: MAX_BUTTONS + 1 }, (_, n) => ({ ...back, id: `b${n}` }))],
    ["a menu inside a menu", [{ id: "m", label: "M", icon: "MoreHorizontal", action: { kind: "menu", items: [{ id: "i", label: "I", icon: "Zap", action: { kind: "menu", items: [] } }] } }]],
    ["an empty menu", [{ id: "m", label: "M", icon: "MoreHorizontal", action: { kind: "menu", items: [] } }]],
    ["an address with no scheme", [{ id: "u", label: "U", icon: "Globe", action: { kind: "openUrl", url: "example.com" } }]],
    ["a bb command with no words", [{ id: "c", label: "C", icon: "Terminal", action: { kind: "bbCommand", args: [] } }]],
    ["an open-thread with no thread", [{ id: "t", label: "T", icon: "MessageSquare", action: { kind: "openThread", threadId: "" } }]],
    ["too many recent threads", [{ id: "r", label: "R", icon: "Clock", action: { kind: "recentThreads", count: 11 } }]],
    ["an action bb does not have", [{ id: "s", label: "Search", icon: "Search", action: { kind: "search" } }]],
  ])("refuses %s", (_, buttons) => {
    expect(layoutProblem(withFolded(buttons))).not.toBeNull();
  });

  it("says where the problem is", () => {
    expect(layoutProblem(withFolded([{ ...back, label: "" }]))).toMatch(/folded\.buttons\.0\.label/);
  });
});

describe("displayFor", () => {
  it("reads bb's compact layout as the folded cover screen and the wide one as the unfolded display", () => {
    expect(displayFor(true)).toBe("folded");
    expect(displayFor(false)).toBe("unfolded");
  });
});

describe("splitArgs and joinArgs", () => {
  it.each<[string, string[]]>([
    ["herald say hello", ["herald", "say", "hello"]],
    ["  herald   say  ", ["herald", "say"]],
    [`herald say "hello there"`, ["herald", "say", "hello there"]],
    [`herald say 'it''s'`, ["herald", "say", "its"]],
    [`a\\ b c`, ["a b", "c"]],
    [`say ""`, ["say", ""]],
    ["", []],
  ])("splits %j", (text, words) => {
    expect(splitArgs(text)).toEqual(words);
  });

  it.each([[["herald", "say", "hello there"]], [["say", "it's"]], [["--flag=1", "a/b.c"]]])("joins %j back into words that split the same", (words) => {
    expect(splitArgs(joinArgs(words))).toEqual(words);
  });
});
