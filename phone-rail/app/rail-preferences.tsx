/**
 * Which preferences the rail reads and writes: bb's shared ones on a wide
 * screen, the phone layout on a compact (phone-sized) one. The rail and its
 * menus read everything through `useRailPreferences`, so they never need to
 * know which applies.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import {
  experimental_useSidebarNavigation,
  type ExperimentalSidebarNavigationItem,
} from "@get-bb/plugin-sdk/app";

import { arrangeItems, withMove, withVisibility } from "../shared/layout";
import { usePhoneLayout, type PhoneLayoutState } from "./phone-layout";

export interface RailPreferences {
  /** True on a compact viewport, where the phone layout applies. */
  isPhone: boolean;
  /** Every destination as this screen shows it, in order, visible and hidden. */
  items: readonly ExperimentalSidebarNavigationItem[];
  /** Every destination as a phone shows it: what the phone editor lists. */
  phoneItems: readonly ExperimentalSidebarNavigationItem[];
  /** The phone layout; "loading" until the server (or this browser's cache) has answered. */
  phoneLayout: PhoneLayoutState;
  /** Hides or shows an item on this screen's rail. */
  setVisible(itemId: string, isVisible: boolean): void;
  /** Opens the editor for this screen: bb's on a wide screen, the phone editor on a phone. */
  openCustomize(): void;
  setPhoneVisible(itemId: string, isVisible: boolean): void;
  movePhoneItem(activeId: string, overId: string): void;
  /** Drops the phone layout: phones follow bb's shared preferences again. */
  resetPhone(): void;
  isPhoneEditorOpen: boolean;
  setPhoneEditorOpen(open: boolean): void;
}

const RailPreferencesContext = createContext<RailPreferences | null>(null);

export function useRailPreferences(): RailPreferences {
  const preferences = useContext(RailPreferencesContext);
  if (preferences === null) throw new Error("useRailPreferences needs a RailPreferencesProvider");
  return preferences;
}

/** The phone's items: bb's own while the phone layout is loading or unset. */
function phoneItemsFor(
  items: readonly ExperimentalSidebarNavigationItem[],
  state: PhoneLayoutState,
): ExperimentalSidebarNavigationItem[] {
  return arrangeItems(items, state.status === "ready" ? state.layout : null);
}

export function RailPreferencesProvider({
  isCompactViewport,
  children,
}: {
  isCompactViewport: boolean;
  children: ReactNode;
}) {
  const { items, actions } = experimental_useSidebarNavigation();
  const { state, save } = usePhoneLayout();
  const [isPhoneEditorOpen, setPhoneEditorOpen] = useState(false);

  const value = useMemo<RailPreferences>(() => {
    const phoneItems = phoneItemsFor(items, state);
    const setPhoneVisible = (itemId: string, isVisible: boolean) =>
      save(withVisibility(phoneItems, itemId, isVisible));
    return {
      isPhone: isCompactViewport,
      items: isCompactViewport ? phoneItems : items,
      phoneItems,
      phoneLayout: state,
      setVisible: isCompactViewport ? setPhoneVisible : (itemId, isVisible) => actions.setVisible(itemId, isVisible),
      openCustomize: isCompactViewport ? () => setPhoneEditorOpen(true) : () => actions.openCustomize(),
      setPhoneVisible,
      movePhoneItem: (activeId, overId) => save(withMove(phoneItems, activeId, overId)),
      resetPhone: () => save(null),
      isPhoneEditorOpen,
      setPhoneEditorOpen,
    };
  }, [items, actions, state, save, isCompactViewport, isPhoneEditorOpen]);

  return <RailPreferencesContext.Provider value={value}>{children}</RailPreferencesContext.Provider>;
}
