/**
 * The phone editor: bb's own customize list (drag to reorder, tick to show)
 * over the phone layout, in a dialog that is a bottom sheet on a phone. Until
 * the server's phone layout has arrived it shows a loading line instead: an
 * edit made over a cached or fallback list would save over the server's.
 */
import { TouchSensor } from "@dnd-kit/core";
import { experimental_SidebarNavigationIcon as SidebarNavigationIcon } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SidebarVisibilityCustomize } from "@/components/ui/sidebar-visibility-customize";

import { NEW_THREAD_ITEM_ID } from "../shared/layout";
import { useRailPreferences } from "./rail-preferences";

export function PhoneEditor() {
  const preferences = useRailPreferences();
  const { phoneItems, phoneLayout, canEditPhone, isPhoneEditorOpen, setPhoneEditorOpen } = preferences;
  // New thread sits in the sidebar header and is never hidden, as on bb's rail.
  const destinations = phoneItems.filter((item) => item.id !== NEW_THREAD_ITEM_ID);
  const hasPhoneLayout = phoneLayout.status === "ready" && phoneLayout.layout !== null;

  return (
    <Dialog open={isPhoneEditorOpen} onOpenChange={setPhoneEditorOpen}>
      <DialogContent data-testid="phone-rail-editor">
        <DialogHeader>
          <DialogTitle>Phone navigation</DialogTitle>
          <DialogDescription>
            {!canEditPhone
              ? "Choose which icons phone-sized screens show on the rail."
              : hasPhoneLayout
                ? "Phone-sized screens show these icons on the rail. Wider windows keep bb's own choice."
                : "Phones show the same icons as wider windows. Change anything here to give phones their own set."}
          </DialogDescription>
        </DialogHeader>
        {canEditPhone ? (
          <SidebarVisibilityCustomize
            variant="card"
            title="Shown on phones"
            listLabel="Phone rail destinations"
            testIdPrefix="phone-rail"
            items={destinations.map((item) => ({
              id: item.id,
              title: item.label,
              icon: <SidebarNavigationIcon icon={item.icon} />,
            }))}
            visibleIds={destinations.filter((item) => item.isVisible).map((item) => item.id)}
            onVisibleChange={preferences.setPhoneVisible}
            onReorder={preferences.movePhoneItem}
            onDone={() => setPhoneEditorOpen(false)}
            touchSensor={TouchSensor}
          />
        ) : (
          <p
            className="flex items-center gap-2 px-1 py-4 text-sm text-muted-foreground"
            data-testid="phone-rail-editor-loading"
          >
            <Icon name="Spinner" className="size-4 animate-spin" aria-hidden="true" />
            Loading the phone's icons…
          </p>
        )}
        {canEditPhone && hasPhoneLayout ? (
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={preferences.resetPhone}>
              Same as wider windows
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
