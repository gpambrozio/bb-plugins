/**
 * bb's tab strip, copied from bb so the Terminals page's tabs look and behave
 * like bb's own: pills with an icon, a close button on the active and the
 * hovered tab, drag to reorder, overflow arrows and fades, and the tab's
 * context menu. Source: get-bb/bb at desktop-v0.48.1 (commit
 * e003e9510cbfd3bb6c26a28630b46ffb1c242a44),
 * apps/app/src/components/secondary-panel/SecondaryPanelTabStrip.tsx. MIT
 * licence, notice in ./LICENSE. Replace it with an SDK component if bb ever
 * exports one.
 *
 * Changes from bb's copy, each for something only this page has:
 * - A tab is the page's own `StripTab`, not bb's panel tab model; no tab is
 *   pinned, and dragging a tab out to another pane (`onBeginTabDrag`) is gone.
 * - The context menu starts with Rename; double click and F2 rename too, and
 *   a tab being renamed draws its name field in the pill's place and does not
 *   drag.
 * - The macOS window-chrome classes are gone: the strip is in a page, never
 *   in the window's title bar.
 * - bb's global `no-scrollbar` class is spelled out as utilities, and the
 *   dragged pill's portal carries the plugin root its styles are scoped to.
 * - The active tab is kept in sight by scrolling the strip itself
 *   (app/scroll-within.ts), not `scrollIntoView`, which also scrolls bb's
 *   containers around the page.
 * - On a compact (phone-sized) viewport bb turns the context menu off and
 *   drags by touch; here the context menu stays, since it holds Rename and the
 *   close actions, and touch does not drag: the touch sensor there (and with
 *   one tab) has no activators, where bb's stand-in still activates.
 * - The active tab is brought back into sight when the order changes too, as
 *   a move in another window can carry it away; bb's strip only reorders
 *   from its own drags.
 */
import {
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type Sensor,
  type SensorInstance,
  type TouchSensorOptions,
} from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Icon } from "@/components/ui/icon";
import { OverflowFade, type OverflowFadeTone } from "@/components/ui/overflow-fade";
import { useDragClickSuppression } from "@/components/ui/use-drag-click-suppression";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";

import { revealWithinX } from "../scroll-within";
import { TabPill } from "./tab-pill";

/** How far the mouse moves with the button down before a tab drags (bb's `PANEL_TAB_DRAG_DISTANCE_PX`). */
export const TAB_DRAG_DISTANCE_PX = 8;

const CHEVRON_SCROLL_STEP_PX = 140;

const TAB_STRIP_SCROLL_BUTTON_CLASS =
  "h-7 w-5 rounded-md p-0 [&_[data-icon-root]]:size-3.5 max-md:pointer-coarse:h-9 max-md:pointer-coarse:w-9 max-md:pointer-coarse:[&_[data-icon-root]]:size-5";

const EDGE_EPSILON_PX = 1;

const TAB_STRIP_FADE_TONE: OverflowFadeTone = "sidebar";

/**
 * The touch sensor's stand-in where touch must not drag: no activators, so nothing starts a drag, and
 * no `setup`. It keeps the sensor list one length, as dnd-kit runs `setup` and its teardown from an
 * effect keyed on the list's entries (6.3.1, `useSensorSetup`): a list that grew from one sensor to
 * two would never set the touch sensor up. bb's `InertTouchSensor` only skips `setup`, so it still
 * activates on a 200 ms hold.
 */
class InertTouchSensor implements SensorInstance {
  static activators: Sensor<TouchSensorOptions>["activators"] = [];
  autoScrollEnabled = false;
}

const TOUCH_SENSOR_OPTIONS: TouchSensorOptions = { activationConstraint: { delay: 200, tolerance: 6 } };

interface TabStripOverflowState {
  hasOverflow: boolean;
  canScrollLeft: boolean;
  canScrollRight: boolean;
}

const INITIAL_OVERFLOW_STATE: TabStripOverflowState = {
  hasOverflow: false,
  canScrollLeft: false,
  canScrollRight: false,
};

/** One tab as the strip draws it. */
export interface StripTab {
  id: string;
  label: string;
  /** The icon before the label. */
  leadingVisual: ReactNode;
  /** Drawn in brackets after the label ("offline", "ended"); null when there is nothing to say. */
  statusLabel: string | null;
  /** The label's tooltip; the label and status when absent. */
  title?: string;
  onSelect: () => void;
  onClose: () => void;
  /** Starts renaming the tab. */
  onRename: () => void;
  /** While the tab is being renamed, the field drawn in the pill's place; null otherwise. */
  editor: ReactNode | null;
}

/** A drag that ended with the tab `activeTabId` over the tab `overTabId`. */
export interface TabReorderRequest {
  activeTabId: string;
  overTabId: string;
}

export interface TabStripProps {
  activeTabId: string | null;
  tabs: readonly StripTab[];
  onReorderTab: (request: TabReorderRequest) => void;
}

export type TabCloseScope = "self" | "others" | "right";

export function tabsToClose(tabs: readonly StripTab[], tabId: string, scope: TabCloseScope): StripTab[] {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) {
    return [];
  }
  return scope === "self"
    ? tabs.slice(index, index + 1)
    : scope === "right"
      ? tabs.slice(index + 1)
      : tabs.filter((tab) => tab.id !== tabId);
}

interface SortableTabProps {
  isActive: boolean;
  activeTabRef: RefObject<HTMLDivElement | null>;
  dragDisabled: boolean;
  onCloseTabs: (tabId: string, scope: TabCloseScope) => void;
  tabs: readonly StripTab[];
  tab: StripTab;
}

export function TabStrip({ activeTabId, tabs, onReorderTab }: TabStripProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);
  const leftScrollButtonRef = useRef<HTMLButtonElement>(null);
  const rightScrollButtonRef = useRef<HTMLButtonElement>(null);
  const [overflow, setOverflow] = useState<TabStripOverflowState>(INITIAL_OVERFLOW_STATE);
  const maxScrollLeftRef = useRef(0);
  const hasOverflowRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const { beginDragClickSuppression, clearDragClickSuppressionSoon, consumeDragClickSuppression } = useDragClickSuppression();
  const isCompactViewport = useIsCompactViewport();
  // The same attributes on every render (they hold no state), so the memo below keeps.
  const [portalScopeProps] = useState(usePortalScopeProps);
  const dragDisabled = tabs.length < 2;
  const mouseSensor = useSensor(MouseSensor, {
    activationConstraint: { distance: TAB_DRAG_DISTANCE_PX },
  });
  // Touch drags only in a wide window with tabs to move; a phone's long press opens the tab's menu.
  const touchDrags = !dragDisabled && !isCompactViewport;
  const touchSensor = useSensor(touchDrags ? TouchSensor : InertTouchSensor, TOUCH_SENSOR_OPTIONS);
  const sensors = useSensors(mouseSensor, touchSensor);
  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const draggingTab = draggingTabId === null ? null : (tabs.find((tab) => tab.id === draggingTabId) ?? null);

  const applyEdgeFlags = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport === null) {
      return;
    }
    const maxScrollLeft = maxScrollLeftRef.current;
    const hasOverflow = hasOverflowRef.current;
    const isScrollable = hasOverflow && maxScrollLeft > EDGE_EPSILON_PX;
    const { scrollLeft } = viewport;
    const canScrollLeft = isScrollable && scrollLeft > EDGE_EPSILON_PX;
    const canScrollRight = isScrollable && scrollLeft < maxScrollLeft - EDGE_EPSILON_PX;
    setOverflow((prev) =>
      prev.hasOverflow === hasOverflow && prev.canScrollLeft === canScrollLeft && prev.canScrollRight === canScrollRight
        ? prev
        : { hasOverflow, canScrollLeft, canScrollRight },
    );
  }, []);

  const measureCapacity = useCallback(() => {
    const strip = stripRef.current;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (strip === null || viewport === null || content === null) {
      return;
    }
    const hasOverflow = content.scrollWidth > strip.clientWidth + EDGE_EPSILON_PX;
    hasOverflowRef.current = hasOverflow;
    maxScrollLeftRef.current = hasOverflow ? Math.max(0, viewport.scrollWidth - viewport.clientWidth) : 0;
    applyEdgeFlags();
  }, [applyEdgeFlags]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) {
      return;
    }
    const handleScroll = () => {
      if (scrollFrameRef.current !== null) {
        return;
      }
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        applyEdgeFlags();
      });
    };
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    const resizeObserver = new ResizeObserver(measureCapacity);
    if (stripRef.current !== null) {
      resizeObserver.observe(stripRef.current);
    }
    resizeObserver.observe(viewport);
    if (contentRef.current !== null) {
      resizeObserver.observe(contentRef.current);
    }
    return () => {
      viewport.removeEventListener("scroll", handleScroll);
      resizeObserver.disconnect();
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [applyEdgeFlags, measureCapacity]);

  useEffect(() => {
    measureCapacity();
  }, [tabs, measureCapacity]);

  useEffect(() => {
    void document.fonts?.ready?.then(() => measureCapacity());
  }, [measureCapacity]);

  // Also when the order changes (a move in another window can carry the active tab out of sight), but
  // not during a drag, which moves the tabs under the pointer.
  const tabOrder = tabIds.join("\n");
  const isDragging = draggingTabId !== null;
  useLayoutEffect(() => {
    const activeTabElement = activeTabRef.current;
    const viewport = viewportRef.current;
    if (activeTabElement === null || viewport === null || isDragging) {
      return;
    }
    revealWithinX(activeTabElement, viewport);
  }, [activeTabId, overflow.hasOverflow, tabOrder, isDragging]);

  useLayoutEffect(() => {
    const focusedElement = document.activeElement;
    const activeTabButton = activeTabRef.current?.querySelector<HTMLButtonElement>("button") ?? null;
    if (!overflow.canScrollLeft && focusedElement === leftScrollButtonRef.current) {
      (overflow.canScrollRight ? rightScrollButtonRef.current : activeTabButton)?.focus();
      return;
    }
    if (!overflow.canScrollRight && focusedElement === rightScrollButtonRef.current) {
      (overflow.canScrollLeft ? leftScrollButtonRef.current : activeTabButton)?.focus();
    }
  }, [overflow.canScrollLeft, overflow.canScrollRight]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY === 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) {
        return;
      }
      const maxScrollLeft = maxScrollLeftRef.current;
      if (maxScrollLeft <= EDGE_EPSILON_PX) {
        return;
      }
      const { scrollLeft } = viewport;
      const canScrollInWheelDirection =
        event.deltaY > 0 ? scrollLeft < maxScrollLeft - EDGE_EPSILON_PX : scrollLeft > EDGE_EPSILON_PX;
      if (!canScrollInWheelDirection) {
        return;
      }
      viewport.scrollLeft = Math.min(maxScrollLeft, Math.max(0, scrollLeft + event.deltaY));
      event.preventDefault();
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", handleWheel);
    };
  }, []);

  const scrollByStep = useCallback((direction: -1 | 1) => {
    viewportRef.current?.scrollBy({
      left: direction * CHEVRON_SCROLL_STEP_PX,
      behavior: "smooth",
    });
  }, []);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      setDraggingTabId(String(event.active.id));
      beginDragClickSuppression();
    },
    [beginDragClickSuppression],
  );
  const handleDragCancel = useCallback(() => {
    setDraggingTabId(null);
    clearDragClickSuppressionSoon();
  }, [clearDragClickSuppressionSoon]);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggingTabId(null);
      clearDragClickSuppressionSoon();
      if (!event.over) {
        return;
      }
      const activeTabId = String(event.active.id);
      const overTabId = String(event.over.id);
      if (activeTabId === overTabId) {
        return;
      }
      onReorderTab({ activeTabId, overTabId });
    },
    [clearDragClickSuppressionSoon, onReorderTab],
  );
  const handleClickCapture = useCallback<MouseEventHandler<HTMLDivElement>>(
    (event) => {
      if (!consumeDragClickSuppression()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [consumeDragClickSuppression],
  );

  const handleCloseTabs = useCallback(
    (tabId: string, scope: TabCloseScope) => {
      const closing = tabsToClose(tabs, tabId, scope);
      const closesActiveTab = closing.some((tab) => tab.id === activeTabId);
      if (scope !== "self" && closesActiveTab) {
        tabs.find((tab) => tab.id === tabId)?.onSelect();
      }
      for (const tab of closing) {
        tab.onClose();
      }
    },
    [activeTabId, tabs],
  );

  const dndTabs = useMemo(
    () => (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragCancel={handleDragCancel}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
          {tabs.map((tab) => (
            <SortableTab
              key={tab.id}
              activeTabRef={activeTabRef}
              dragDisabled={dragDisabled}
              isActive={tab.id === activeTabId}
              onCloseTabs={handleCloseTabs}
              tab={tab}
              tabs={tabs}
            />
          ))}
        </SortableContext>
        {createPortal(
          // The plugin's styles apply only inside a plugin root, so the dragged pill carries one.
          <div {...portalScopeProps}>
            <DragOverlay className="cursor-grabbing">
              {draggingTab === null ? null : <StripTabPill isActive={draggingTab.id === activeTabId} tab={draggingTab} />}
            </DragOverlay>
          </div>,
          document.body,
        )}
      </DndContext>
    ),
    [
      sensors,
      handleDragStart,
      handleDragCancel,
      handleDragEnd,
      tabIds,
      tabs,
      dragDisabled,
      handleCloseTabs,
      draggingTab,
      activeTabId,
      portalScopeProps,
    ],
  );

  return (
    <div
      ref={stripRef}
      data-testid="terminals-tab-strip"
      className="group relative flex min-w-0 items-center [&_[data-tab-pill-close]]:text-muted-foreground/70 [&_[data-tab-pill-close]:hover]:text-foreground [&_[data-tab-pill-close]_[data-icon-root]]:size-3"
    >
      <TabStripScrollButton
        buttonRef={leftScrollButtonRef}
        direction="left"
        canScroll={overflow.canScrollLeft}
        onClick={() => scrollByStep(-1)}
      />
      <div data-tab-strip-scroll-region className="relative min-w-0">
        <OverflowFade
          placement="left"
          tone={TAB_STRIP_FADE_TONE}
          className={cn("z-10", overflow.canScrollLeft ? "opacity-100" : "opacity-0")}
        />
        <OverflowFade
          placement="right"
          tone={TAB_STRIP_FADE_TONE}
          className={cn("z-10", overflow.canScrollRight ? "opacity-100" : "opacity-0")}
        />
        <div
          ref={viewportRef}
          onClickCapture={handleClickCapture}
          className="min-w-0 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div ref={contentRef} data-tab-strip-content className="flex w-max items-center gap-1">
            {dndTabs}
          </div>
        </div>
      </div>
      <TabStripScrollButton
        buttonRef={rightScrollButtonRef}
        direction="right"
        canScroll={overflow.canScrollRight}
        onClick={() => scrollByStep(1)}
      />
    </div>
  );
}

function SortableTab({ activeTabRef, dragDisabled, isActive, onCloseTabs, tab, tabs }: SortableTabProps) {
  const editing = tab.editor !== null;
  const { isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: tab.id,
    disabled: dragDisabled || editing,
  });
  const setTabRef = useCallback(
    (element: HTMLDivElement | null) => {
      setNodeRef(element);
      if (isActive) {
        activeTabRef.current = element;
      }
    },
    [activeTabRef, isActive, setNodeRef],
  );
  const style = useMemo<CSSProperties>(
    () => ({
      transform: CSS.Translate.toString(transform),
      transition,
    }),
    [transform, transition],
  );

  const tabId = tab.id;
  const canCloseOthers = tabsToClose(tabs, tabId, "others").length > 0;
  const canCloseRight = tabsToClose(tabs, tabId, "right").length > 0;

  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild disabled={editing}>
        <div
          ref={setTabRef}
          style={style}
          data-strip-tab={tabId}
          data-active={isActive ? "" : undefined}
          className={cn(
            "shrink-0",
            !dragDisabled && !editing && "cursor-grab active:cursor-grabbing",
            isDragging && "opacity-40",
          )}
          onDoubleClick={editing ? undefined : tab.onRename}
          onKeyDown={(event) => {
            // F2 renames, as it renames a file or a terminal tab elsewhere.
            if (!editing && event.key === "F2") {
              event.preventDefault();
              tab.onRename();
            }
          }}
          {...(editing ? {} : listeners)}
        >
          {editing ? (
            <div
              data-tab-pill=""
              className="inline-flex h-7 shrink-0 items-center rounded-md bg-state-active pl-1.5 pr-1 text-xs text-foreground max-md:pointer-coarse:h-9"
            >
              <span className="mr-1.5 inline-flex size-4 shrink-0 items-center justify-center [&_[data-icon-root]]:size-3.5">
                {tab.leadingVisual}
              </span>
              {tab.editor}
            </div>
          ) : (
            <StripTabPill tab={tab} isActive={isActive} />
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        aria-label={`${tab.label} tab actions`}
        // The name field takes focus itself; the menu must not hand it back to the tab.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <ContextMenuItem onSelect={tab.onRename}>Rename</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onCloseTabs(tabId, "self")}>Close tab</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!canCloseOthers} onSelect={() => onCloseTabs(tabId, "others")}>
          Close other tabs
        </ContextMenuItem>
        <ContextMenuItem disabled={!canCloseRight} onSelect={() => onCloseTabs(tabId, "right")}>
          Close tabs to the right
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface TabStripScrollButtonProps {
  buttonRef: RefObject<HTMLButtonElement | null>;
  direction: "left" | "right";
  canScroll: boolean;
  onClick: () => void;
}

function TabStripScrollButton({ buttonRef, direction, canScroll, onClick }: TabStripScrollButtonProps) {
  const label = direction === "left" ? "Scroll tabs left" : "Scroll tabs right";
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant="ghost"
      size="sm"
      tabIndex={canScroll ? 0 : -1}
      aria-hidden={!canScroll}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "z-20 shrink-0 bg-sidebar text-muted-foreground/70 shadow-none hover:bg-surface-raised-solid hover:text-foreground focus-visible:bg-sidebar",
        canScroll ? TAB_STRIP_SCROLL_BUTTON_CLASS : "h-7 w-0 overflow-hidden p-0 max-md:pointer-coarse:h-9",
        "transition-opacity",
        canScroll ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <Icon name={direction === "left" ? "ChevronLeft" : "ChevronRight"} />
    </Button>
  );
}

function StripTabPill({ tab, isActive }: { tab: StripTab; isActive: boolean }) {
  const title = tab.title ?? (tab.statusLabel === null ? tab.label : `${tab.label} (${tab.statusLabel})`);
  return (
    <TabPill
      label={tab.label}
      leadingVisual={tab.leadingVisual}
      secondaryLabel={tab.statusLabel === null ? null : `(${tab.statusLabel})`}
      title={title}
      isActive={isActive}
      onSelect={tab.onSelect}
      labelMaxWidthClass="max-w-[160px]"
      closeAction={{
        onClose: tab.onClose,
        closeLabel: `Close ${tab.label}`,
      }}
    />
  );
}
