// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultLayout, serializeLayout, type Layout } from "../shared/layout";

afterEach(cleanup);

const projects = [{ id: "p1", name: "Acme Web" }];

async function renderEditor(settings: Record<string, string | number | boolean> = {}) {
  const updateSettings = vi.fn(async (_args: { pluginId: string; values: Record<string, unknown> }) => ({}));
  const app = await loadPluginApp(() => import("../app"));
  const section = app.settingsSections.find((entry) => entry.id === "buttons");
  if (section === undefined) throw new Error("no Buttons settings section");
  const slot = await renderSlot(section, {}, {
    pluginId: "duo-rail",
    settings,
    sdk: {
      projects: { list: async () => projects },
      plugins: { list: async () => ({ plugins: [{ id: "herald", enabled: true, cliCommand: { name: "herald", summary: "Speak" } }] }), updateSettings },
    } as never,
    threadActionRegistrations: [{ key: "bb--core/pin", pluginId: "bb--core", title: "Pin", icon: "Pin" }],
  });
  return { slot, updateSettings };
}

/** What the editor saved, read back as a layout. */
function saved(updateSettings: ReturnType<typeof vi.fn>): Layout {
  const call = updateSettings.mock.calls.at(-1)?.[0] as { values: { layout: string } };
  return JSON.parse(call.values.layout) as Layout;
}

const labels = () => within(screen.getByRole("list", { name: "Buttons" })).getAllByRole("listitem").filter((item) => item.parentElement?.getAttribute("aria-label") === "Buttons").map((item) => item.getAttribute("aria-label"));

describe("the button editor", () => {
  it("shows the default buttons, saved", async () => {
    await renderEditor();
    expect(labels()).toEqual(["Back", "New thread", "More"]);
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/Saved\./)).toBeTruthy();
  });

  it("reorders and removes buttons, and saves to the layout setting", async () => {
    const { updateSettings } = await renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Move New thread up" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove More" }));
    expect(labels()).toEqual(["New thread", "Back"]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledOnce());
    expect(updateSettings.mock.calls[0]?.[0].pluginId).toBe("duo-rail");
    const layout = saved(updateSettings);
    expect(layout.folded.buttons.map((button) => button.label)).toEqual(["New thread", "Back"]);
    // The other display is untouched.
    expect(layout.unfolded).toEqual(defaultLayout().unfolded);
  });

  it("keeps a separate list for the unfolded display", async () => {
    const { updateSettings } = await renderEditor();
    fireEvent.click(screen.getByRole("tab", { name: "Unfolded" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Back" }));
    fireEvent.click(screen.getByRole("tab", { name: "Folded" }));
    expect(labels()).toEqual(["Back", "New thread", "More"]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledOnce());
    expect(saved(updateSettings).unfolded.buttons.map((button) => button.label)).toEqual(["New thread", "More"]);
  });

  it("adds a button, and gives it a name, a symbol and an action", async () => {
    const { updateSettings } = await renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Edit New thread" }).at(-1) as HTMLElement);
    const row = screen.getAllByRole("listitem", { name: "New thread" }).at(-1) as HTMLElement;
    fireEvent.change(within(row).getByLabelText("Action"), { target: { value: "openProject" } });
    fireEvent.change(within(row).getByLabelText("Project"), { target: { value: "p1" } });
    fireEvent.change(within(row).getByLabelText("Name"), { target: { value: "Acme" } });
    fireEvent.click(within(row).getByRole("radio", { name: "Star" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledOnce());
    expect(saved(updateSettings).folded.buttons.at(-1)).toEqual({ id: "newThread", label: "Acme", icon: "Star", action: { kind: "openProject", projectId: "p1" } });
  });

  it("edits a menu's items", async () => {
    const { updateSettings } = await renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Edit More" }));
    const items = screen.getByRole("list", { name: "Menu items" });
    fireEvent.click(within(items).getByRole("button", { name: "Remove Reload bb" }));
    fireEvent.click(screen.getByRole("button", { name: "Add menu item" }));
    fireEvent.click(within(items).getAllByRole("button", { name: /^Edit / }).at(-1) as HTMLElement);
    const added = within(items).getAllByRole("listitem").at(-1) as HTMLElement;
    fireEvent.change(within(added).getByLabelText("Action"), { target: { value: "bbCommand" } });
    fireEvent.change(within(added).getByLabelText("Command, after bb"), { target: { value: `herald say "hello there"` } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledOnce());
    const more = saved(updateSettings).folded.buttons[2]?.action;
    expect(more?.kind === "menu" && more.items.map((item) => item.action)).toEqual([
      { kind: "recentThreads", count: 5 },
      { kind: "forward" },
      { kind: "bbCommand", args: ["herald", "say", "hello there"] },
    ]);
  });

  it("offers bb's thread-menu actions to run on the open thread", async () => {
    await renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Edit Back" }));
    const row = screen.getByRole("listitem", { name: "Back" });
    fireEvent.change(within(row).getByLabelText("Action"), { target: { value: "threadAction" } });
    expect(within(within(row).getByLabelText("Action from bb's thread menu")).getAllByRole("option").map((option) => option.textContent)).toEqual(["Pin"]);
  });

  it("will not save a layout the rail could not draw, and says why", async () => {
    const { updateSettings } = await renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Edit Back" }));
    fireEvent.change(within(screen.getByRole("listitem", { name: "Back" })).getByLabelText("Name"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("alert").textContent).toMatch(/folded\.buttons\.0\.label/);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("copies the other display's buttons, goes back to the default, and discards", async () => {
    const unfolded = { ...defaultLayout(), unfolded: { buttons: [{ id: "f", label: "Forward", icon: "ArrowRight", action: { kind: "forward" as const } }] } };
    await renderEditor({ layout: serializeLayout(unfolded) });
    fireEvent.click(screen.getByRole("button", { name: "Copy the unfolded buttons" }));
    expect(labels()).toEqual(["Forward"]);
    fireEvent.click(screen.getByRole("button", { name: "Back to the default buttons" }));
    expect(labels()).toEqual(["Back", "New thread", "More"]);
    fireEvent.click(screen.getByRole("button", { name: "Copy the unfolded buttons" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(labels()).toEqual(["Back", "New thread", "More"]);
  });

  it("says when the saved layout could not be read", async () => {
    await renderEditor({ layout: "{ broken" });
    expect(screen.getByRole("alert").textContent).toContain("not valid JSON");
    expect(labels()).toEqual(["Back", "New thread", "More"]);
  });
});
