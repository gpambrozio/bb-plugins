import { describe, expect, it } from "vitest";

import { layoutProblem, MAX_BUTTONS, type MenuItem, type RailButton } from "../shared/layout";
import {
  ACTION_CHOICES,
  canAddButton,
  describeAction,
  MENU_ITEM_CHOICES,
  moveAt,
  newAction,
  newButton,
  newMenuItem,
  removeAt,
  replaceAt,
  uniqueId,
  withKind,
  type Names,
} from "./editor-model";

const names: Names = {
  thread: (id) => (id === "t1" ? "Fix the upload test" : undefined),
  project: (id) => (id === "p1" ? "Acme Web" : undefined),
  threadAction: (key) => (key === "bb--core/pin" ? "Pin" : undefined),
};

const valid = (buttons: RailButton[]) => layoutProblem(JSON.stringify({ version: 1, folded: { buttons }, unfolded: { buttons: [] } }));

describe("the action picker", () => {
  it("offers every action with an SDK route, and a menu only for a button", () => {
    expect(ACTION_CHOICES.map((choice) => choice.kind)).toEqual([
      "back",
      "forward",
      "newThread",
      "recentThreads",
      "openThread",
      "openProject",
      "threadAction",
      "bbCommand",
      "openUrl",
      "reload",
      "menu",
    ]);
    expect(MENU_ITEM_CHOICES.map((choice) => choice.kind)).not.toContain("menu");
  });

  it("starts each action as a valid one when there is something to pick", () => {
    const offers = { firstThreadId: "t1", firstProjectId: "p1", firstThreadActionKey: "bb--core/pin", firstCliCommand: "herald" };
    const buttons = ACTION_CHOICES.reduce<RailButton[]>((list, choice) => [...list, newButton(list, choice.kind, offers)], []);
    for (const button of buttons) expect(valid([button])).toBeNull();
  });

  it("starts the ones that name something empty when there is nothing to pick, and saving says so", () => {
    expect(newAction("openThread")).toEqual({ kind: "openThread", threadId: "" });
    expect(valid([newButton([], "openThread")])).not.toBeNull();
  });
});

describe("withKind", () => {
  const button: RailButton = { id: "b", label: "Back", icon: "ArrowLeft", action: { kind: "back" } };

  it("gives a button still named and drawn as its old action the new action's name and symbol", () => {
    expect(withKind(button, "openUrl")).toEqual({ id: "b", label: "Link", icon: "Globe", action: { kind: "openUrl", url: "https://" } });
  });

  it("keeps a name and a symbol the owner chose", () => {
    expect(withKind({ ...button, label: "Previous", icon: "ArrowTurnBackward" }, "forward")).toMatchObject({ label: "Previous", icon: "ArrowTurnBackward", action: { kind: "forward" } });
  });

  it("turns a button into a menu with one item", () => {
    const menu = withKind(button, "menu");
    expect(menu.action.kind === "menu" && menu.action.items).toHaveLength(1);
  });

  it("leaves a button alone when the kind is the same", () => {
    expect(withKind(button, "back")).toBe(button);
  });
});

describe("ids", () => {
  it("never repeats one", () => {
    expect(uniqueId("back", [{ id: "back" }, { id: "back-2" }])).toBe("back-3");
    const items: MenuItem[] = [];
    items.push(newMenuItem(items, "forward"));
    items.push(newMenuItem(items, "forward"));
    expect(items.map((item) => item.id)).toEqual(["forward", "forward-2"]);
  });
});

describe("list edits", () => {
  it("moves, removes and replaces without changing the list it was given", () => {
    const list = ["a", "b", "c"] as const;
    expect(moveAt(list, 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveAt(list, 2, -2)).toEqual(["c", "a", "b"]);
    expect(moveAt(list, 0, -1)).toEqual(["a", "b", "c"]);
    expect(removeAt(list, 1)).toEqual(["a", "c"]);
    expect(replaceAt(list, 1, "x")).toEqual(["a", "x", "c"]);
    expect(list).toEqual(["a", "b", "c"]);
  });

  it("stops adding at the most buttons the strip holds", () => {
    const full = Array.from({ length: MAX_BUTTONS }, (_, n) => ({ id: `b${n}`, label: "B", icon: "Zap", action: { kind: "back" as const } }));
    expect(canAddButton(full)).toBe(false);
    expect(canAddButton(full.slice(1))).toBe(true);
  });
});

describe("describeAction", () => {
  it.each<[Parameters<typeof describeAction>[0], string]>([
    [{ kind: "newThread", projectId: null }, "Opens bb's New thread screen"],
    [{ kind: "newThread", projectId: "p1" }, "New thread in Acme Web"],
    [{ kind: "openThread", threadId: "t1" }, "Opens Fix the upload test"],
    [{ kind: "openThread", threadId: "gone" }, "Opens a thread that is no longer listed"],
    [{ kind: "threadAction", key: "bb--core/pin" }, "Pin, on the open thread"],
    [{ kind: "bbCommand", args: ["herald", "say", "hi there"] }, "Runs bb herald say 'hi there'"],
    [{ kind: "recentThreads", count: 5 }, "The 5 most recent threads"],
    [{ kind: "menu", items: [{ id: "f", label: "Forward", icon: "ArrowRight", action: { kind: "forward" } }] }, "A menu: Forward"],
  ])("describes %j", (action, text) => {
    expect(describeAction(action, names)).toBe(text);
  });
});
