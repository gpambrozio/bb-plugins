/**
 * The session toolbar's Clipboard menu — Auto sync, Send and Receive — and
 * the notice saying what the last of them did. The work is in clipboard.ts;
 * like Send keys, the menu acts only on a connected session that is not View
 * only.
 */
import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { clipboardPreference, type ClipboardAccess } from "./clipboard";
import { canType } from "./keys-toolbar";
import type { ScreenSessionSnapshot, ScreenSessionStore } from "./session-store";
import { ToolbarMenu, ToolbarMenuCheckboxItem, ToolbarMenuItem, ToolbarMenuNote, ToolbarMenuSeparator } from "./toolbar-menu";

export function useAutoSyncClipboard(): boolean {
  return useSyncExternalStore(clipboardPreference.subscribe, clipboardPreference.getAutoSync);
}

/** Whose clipboard on the Mac the menu reaches, before the Mac has said and after. */
function accountNote(access: ClipboardAccess | null, hostName: string): string {
  const whose = access?.available === true ? `${access.account.userName}, the account` : "the macOS account";
  return `Text only. It reaches the clipboard of ${whose} bb runs as on ${hostName}.`;
}

/**
 * The Clipboard menu. When sync cannot work for the session — a sign-in as
 * another account, a Mac whose clipboard could not be reached — it holds only
 * the reason, one step up the type scale, and no items; opening it asks an
 * unreachable Mac again.
 */
export function ClipboardMenu({ store, session }: { store: ScreenSessionStore; session: ScreenSessionSnapshot }) {
  const autoSync = useAutoSyncClipboard();
  const hostName = session.hostName ?? "the Mac";
  const access = session.clipboardAccess;
  return (
    <ToolbarMenu label="Clipboard" icon="Copy" menuLabel="Clipboard" enabled={canType(session)} onOpen={() => store.refreshClipboardAccess()}>
      {(close) =>
        access?.available === false ? (
          <ToolbarMenuNote prominent>{access.reason}</ToolbarMenuNote>
        ) : (
          <>
            <ToolbarMenuCheckboxItem
              checked={autoSync}
              onSelect={() => {
                close();
                void store.setAutoSyncClipboard(!autoSync);
              }}
            >
              <span>Auto sync clipboard</span>
            </ToolbarMenuCheckboxItem>
            <ToolbarMenuSeparator />
            <ToolbarMenuItem
              onSelect={() => {
                close();
                void store.sendClipboard();
              }}
            >
              <span>Send clipboard</span>
              <span className="truncate text-xs text-muted-foreground">to {hostName}</span>
            </ToolbarMenuItem>
            <ToolbarMenuItem
              onSelect={() => {
                close();
                void store.receiveClipboard();
              }}
            >
              <span>Receive clipboard</span>
              <span className="truncate text-xs text-muted-foreground">from {hostName}</span>
            </ToolbarMenuItem>
            <ToolbarMenuNote>{accountNote(access, hostName)}</ToolbarMenuNote>
          </>
        )
      }
    </ToolbarMenu>
  );
}

/** What the last clipboard action, or Auto sync, had to say. */
export function ClipboardNotice({ store, session }: { store: ScreenSessionStore; session: ScreenSessionSnapshot }) {
  const notice = session.clipboardNotice;
  if (notice === null) return null;
  const warning = notice.tone === "warning";
  return (
    <div role="status" className="flex items-center gap-2 border-b border-border bg-card px-4 py-1.5 text-xs">
      <Icon name={warning ? "AlertTriangle" : "Info"} />
      <span className={warning ? "flex-1 text-warning-text" : "flex-1"}>{notice.text}</span>
      {notice.copy !== undefined ? (
        <Button type="button" size="sm" variant="outline" onClick={() => void store.copyClipboardFromNotice()}>
          Copy
        </Button>
      ) : null}
      <Button type="button" size="sm" variant="ghost" aria-label="Dismiss" onClick={() => store.dismissClipboardNotice()}>
        <Icon name="X" />
      </Button>
    </div>
  );
}
