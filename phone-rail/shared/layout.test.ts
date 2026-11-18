import { describe, expect, it } from "vitest";

import {
  arrangeItems,
  layoutFromItems,
  NavigationLayoutSchema,
  NEW_THREAD_ITEM_ID,
  withMove,
  withVisibility,
} from "./layout";

const item = (id: string, isVisible = true) => ({ id, isVisible });

// bb's shared order and visibility, as `experimental_useSidebarNavigation` gives them.
const SHARED = [
  item(NEW_THREAD_ITEM_ID),
  item("__bb__/extensions"),
  item("garden/docs"),
  item("__bb__/skills", false),
  item("board/board"),
];

const ids = (items: readonly { id: string }[]) => items.map((each) => each.id);
const shown = (items: readonly { id: string; isVisible: boolean }[]) =>
  items.filter((each) => each.isVisible).map((each) => each.id);

describe("arrangeItems", () => {
  it("leaves bb's shared preferences alone when the phone has no layout", () => {
    expect(arrangeItems(SHARED, null)).toEqual(SHARED);
  });

  it("orders and shows what the phone layout says", () => {
    const arranged = arrangeItems(SHARED, {
      visible: ["board/board"],
      order: ["board/board", "__bb__/skills", NEW_THREAD_ITEM_ID],
    });
    expect(ids(arranged)).toEqual([
      "board/board",
      "__bb__/skills",
      NEW_THREAD_ITEM_ID,
      "__bb__/extensions",
      "garden/docs",
    ]);
    // New thread is never hidden; Plugins and Docs are, since the layout does not list them.
    expect(shown(arranged)).toEqual(["board/board", NEW_THREAD_ITEM_ID]);
  });

  it("puts a destination installed after the layout was saved in More, after the listed ones", () => {
    const layout = layoutFromItems(SHARED);
    const arranged = arrangeItems([...SHARED, item("new/panel")], layout);
    expect(ids(arranged).at(-1)).toBe("new/panel");
    expect(arranged.at(-1)?.isVisible).toBe(false);
  });

  it("ignores ids bb no longer has", () => {
    const arranged = arrangeItems(SHARED, {
      visible: ["gone/panel", "garden/docs"],
      order: ["gone/panel", "garden/docs"],
    });
    expect(ids(arranged)[0]).toBe("garden/docs");
    expect(arranged).toHaveLength(SHARED.length);
  });

  it("returns the same item object when nothing about it changed", () => {
    const arranged = arrangeItems(SHARED, layoutFromItems(SHARED));
    arranged.forEach((each, index) => expect(each).toBe(SHARED[index]));
  });
});

describe("withVisibility", () => {
  it("starts a first edit from what the phone shows now", () => {
    const layout = withVisibility(SHARED, "garden/docs", false);
    expect(layout.order).toEqual(ids(SHARED));
    expect(layout.visible).toEqual([NEW_THREAD_ITEM_ID, "__bb__/extensions", "board/board"]);
  });

  it("shows a hidden item", () => {
    expect(withVisibility(SHARED, "__bb__/skills", true).visible).toContain("__bb__/skills");
  });
});

describe("withMove", () => {
  it("moves an item down to the target's place", () => {
    expect(withMove(SHARED, "__bb__/extensions", "__bb__/skills").order).toEqual([
      NEW_THREAD_ITEM_ID,
      "garden/docs",
      "__bb__/skills",
      "__bb__/extensions",
      "board/board",
    ]);
  });

  it("moves an item up to the target's place", () => {
    expect(withMove(SHARED, "board/board", "__bb__/extensions").order).toEqual([
      NEW_THREAD_ITEM_ID,
      "board/board",
      "__bb__/extensions",
      "garden/docs",
      "__bb__/skills",
    ]);
  });

  it("changes nothing for an unknown id", () => {
    expect(withMove(SHARED, "gone/panel", "garden/docs")).toEqual(layoutFromItems(SHARED));
  });
});

describe("NavigationLayoutSchema", () => {
  it("refuses an empty id and an oversized list", () => {
    expect(NavigationLayoutSchema.safeParse({ visible: [""], order: [] }).success).toBe(false);
    const many = Array.from({ length: 501 }, (_, index) => `p/${index}`);
    expect(NavigationLayoutSchema.safeParse({ visible: [], order: many }).success).toBe(false);
  });
});
