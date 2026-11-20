/**
 * Which header control the app registers: its own menu button where bb still draws the old header
 * slot, else a header thread action that opens the Actions tab.
 */
import type { PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import { describe, expect, it, vi } from "vitest";

import { registerActions } from "../app";
import { ActionsHeaderButton } from "./actions-menu";
import { EditorTab } from "./editor";

function builder(withLegacySlot: boolean) {
  const slots = {
    experimental_tab: vi.fn(),
    experimental_threadAction: vi.fn(),
    ...(withLegacySlot ? { experimental_threadHeaderAction: vi.fn() } : {}),
  };
  return { app: { slots } as unknown as PluginAppBuilder, slots };
}

describe("registerActions", () => {
  it("puts its own menu button in the header where bb draws the old slot", () => {
    const { app, slots } = builder(true);
    expect(registerActions(app)).toBe("menu");
    expect(slots.experimental_threadHeaderAction).toHaveBeenCalledWith({ id: "actions", title: "Project actions", component: ActionsHeaderButton });
    expect(slots.experimental_threadAction).not.toHaveBeenCalled();
    // Only the editor's tab: the menu runs the actions.
    expect(slots.experimental_tab.mock.calls).toEqual([[expect.objectContaining({ id: "edit-actions", context: { kind: "thread" }, availability: "action", component: EditorTab })]]);
  });

  it("falls back to a header thread action that opens the Actions tab", () => {
    const { app, slots } = builder(false);
    expect(registerActions(app)).toBe("tab");
    expect(slots.experimental_tab).toHaveBeenCalledWith(expect.objectContaining({ id: "actions", context: { kind: "thread" }, availability: "action" }));
    expect(slots.experimental_tab).toHaveBeenCalledWith(expect.objectContaining({ id: "edit-actions" }));
    const [registration] = slots.experimental_threadAction.mock.calls[0] as [{ placement: string; item: (input: unknown) => { run: () => void } }];
    expect(registration.placement).toBe("header");
    const openTab = vi.fn();
    registration.item({ experimental_panel: { openTab } }).run();
    expect(openTab).toHaveBeenCalledWith({ tab: { id: "actions", context: { kind: "thread" }, availability: "action" } });
  });
});
