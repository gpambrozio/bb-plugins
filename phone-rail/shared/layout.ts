/**
 * The phone layout: which rail destinations a compact (phone-sized) screen
 * shows, and in what order. Plain data and pure functions, shared by the
 * server (which stores it) and the app (which draws it). No SDK import, so
 * the app may import this at run time.
 *
 * A layout lists item ids as bb's own sidebar preferences do
 * (`sidebar.visiblePluginPanels` and `sidebar.pluginPanelOrder`): `__bb__/…`
 * for bb's destinations and `<pluginId>/<panelId>` for plugin panels. A
 * missing layout (null) means "use bb's shared preferences".
 */
import { z } from "zod";

/** bb's New thread item. The rail draws it in the sidebar header; it is never hidden. */
export const NEW_THREAD_ITEM_ID = "__bb__/new-thread";

/** The realtime channel the server announces a changed layout on. */
export const LAYOUT_CHANGED_CHANNEL = "layout-changed";

/** Far more destinations than any sidebar holds; it only bounds what is stored. */
const MAX_ITEMS = 500;
const ItemId = z.string().min(1).max(300);

export const NavigationLayoutSchema = z.object({
  /** The ids shown on the rail. Every other destination sits in More. */
  visible: z.array(ItemId).max(MAX_ITEMS),
  /** The ids in rail order. Destinations not listed follow, in bb's shared order. */
  order: z.array(ItemId).max(MAX_ITEMS),
});

export type NavigationLayout = z.infer<typeof NavigationLayoutSchema>;

/** What arranging needs from an item: bb's `ExperimentalSidebarNavigationItem` fits. */
export interface ArrangeableItem {
  id: string;
  isVisible: boolean;
}

/**
 * The items as a phone shows them: in the layout's order, visible when the
 * layout lists them. Items the layout leaves out of `order` (a plugin
 * installed since) keep bb's shared order after the listed ones, and ones it
 * leaves out of `visible` are hidden, so a new destination lands in More
 * rather than crowding the phone's rail. Ids the layout names that bb no
 * longer has are ignored. With no layout, the items are returned unchanged.
 */
export function arrangeItems<T extends ArrangeableItem>(
  items: readonly T[],
  layout: NavigationLayout | null,
): T[] {
  if (layout === null) return [...items];
  const rank = new Map(layout.order.map((id, index) => [id, index]));
  const visible = new Set(layout.visible);
  const listed = items.filter((item) => rank.has(item.id));
  const unlisted = items.filter((item) => !rank.has(item.id));
  listed.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...listed, ...unlisted].map((item) => {
    const isVisible = item.id === NEW_THREAD_ITEM_ID || visible.has(item.id);
    return isVisible === item.isVisible ? item : { ...item, isVisible };
  });
}

/** A layout that shows exactly what `items` shows now: the starting point of a first phone edit. */
export function layoutFromItems(items: readonly ArrangeableItem[]): NavigationLayout {
  return {
    visible: items.filter((item) => item.isVisible).map((item) => item.id),
    order: items.map((item) => item.id),
  };
}

/**
 * Shows or hides one item. `items` is what the phone shows now (already
 * arranged), so a first edit starts from bb's shared preferences.
 */
export function withVisibility(
  items: readonly ArrangeableItem[],
  itemId: string,
  isVisible: boolean,
): NavigationLayout {
  const base = layoutFromItems(items);
  const visible = base.visible.filter((id) => id !== itemId);
  if (isVisible) visible.push(itemId);
  return { visible, order: base.order };
}

/**
 * Moves `activeId` to where `overId` is, as a drag in the customize list does:
 * after it when moving down, before it when moving up. Unknown ids change
 * nothing.
 */
export function withMove(
  items: readonly ArrangeableItem[],
  activeId: string,
  overId: string,
): NavigationLayout {
  const base = layoutFromItems(items);
  const from = base.order.indexOf(activeId);
  const to = base.order.indexOf(overId);
  if (from === -1 || to === -1 || from === to) return base;
  const order = [...base.order];
  order.splice(from, 1);
  order.splice(to, 0, activeId);
  return { visible: base.visible, order };
}
