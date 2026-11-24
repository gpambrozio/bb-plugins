// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rpcContract } from "../shared/contract";
import { defaultLayout, NEW_THREAD_ICON, type Layout } from "../shared/layout";
import { revealWithin } from "./editor";
import { ICON_CHOICES } from "./editor-model";
import { EXIT_MARKER } from "./bb-command";
import { resetCommandCatalogCache } from "./command-picker";

afterEach(() => {
  cleanup();
  resetCommandCatalogCache();
});

/** What the command listing prints on a bb with two plugins (see command-catalog.ts). */
const CATALOG_OUTPUT = [
  "@@duo-rail:core@@",
  "bb thread list",
  "    List threads",
  "bb plugin reload [id]",
  "    Reload plugins",
  "@@duo-rail:plugin agent-graph@@",
  "Commands:",
  "  bb agent-graph show  Print the agent graph (default)",
  "",
  "@@duo-rail:plugin git@@",
  "Commands:",
  "  bb git status       Show an environment's workspace status",
  "  bb git viewed list  List files marked Viewed",
  "",
].join("\r\n");

const commandLine = {
  system: {
    experimental_cliCommand: async () => ({ installedPath: "/usr/local/bin/bb", supported: true, onPath: true, shadowedBy: null }),
    config: async () => ({ primaryHostId: "host1" }),
  },
  terminals: {
    create: async () => ({ id: "term1" }),
    output: async () => ({
      chunks: [{ seq: 1, dataBase64: Buffer.from(`${CATALOG_OUTPUT}${EXIT_MARKER}0\u0007`).toString("base64") }],
      nextSeq: 2,
      status: "running",
      exitCode: null,
      closeReason: null,
      truncated: false,
    }),
    close: async () => ({}),
  },
};

const projects = [{ id: "p1", name: "Acme Web" }];

/** Renders the Buttons section over a fake server store that starts with `stored` (the default when omitted). */
async function renderEditor(stored: { layout: Layout; problem?: string } = { layout: defaultLayout() }) {
  let server = { layout: stored.layout, problem: stored.problem ?? null };
  const layoutSet = vi.fn((input: unknown) => {
    const { layout } = input as { layout: Layout };
    server = { layout, problem: null };
    return { layout };
  });
  const app = await loadPluginApp(() => import("../app"));
  const section = app.settingsSections.find((entry) => entry.id === "buttons");
  if (section === undefined) throw new Error("no Buttons settings section");
  const slot = await renderSlot(section, {}, {
    pluginId: "duo-rail",
    experimental_rpcContract: rpcContract,
    rpc: { "layout.get": () => server, "layout.set": layoutSet },
    sdk: {
      projects: { list: async () => projects },
      plugins: {
        list: async () => ({
          plugins: [
            { id: "agent-graph", enabled: true, cliCommand: { name: "agent-graph", summary: "Show a live graph of agents" } },
            { id: "bb--git", enabled: true, cliCommand: { name: "git", summary: "Read an environment's git status" } },
            { id: "off", enabled: false, cliCommand: { name: "off", summary: "A disabled plugin" } },
          ],
        }),
      },
      ...commandLine,
    } as never,
    threadActionRegistrations: [{ key: "bb--core/pin", pluginId: "bb--core", title: "Pin", icon: "Pin" }],
  });
  await screen.findByTestId("duo-rail-editor");
  return { slot, layoutSet };
}

/** What the editor last saved. */
function saved(layoutSet: ReturnType<typeof vi.fn>): Layout {
  return (layoutSet.mock.calls.at(-1)?.[0] as { layout: Layout }).layout;
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
    const { layoutSet } = await renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Move New thread up" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove More" }));
    expect(labels()).toEqual(["New thread", "Back"]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(layoutSet).toHaveBeenCalledOnce());
    const layout = saved(layoutSet);
    expect(layout.folded.buttons.map((button) => button.label)).toEqual(["New thread", "Back"]);
    // The other display is untouched.
    expect(layout.unfolded).toEqual(defaultLayout().unfolded);
  });

  it("keeps a separate list for the unfolded display", async () => {
    const { layoutSet } = await renderEditor();
    fireEvent.click(screen.getByRole("tab", { name: "Unfolded" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Back" }));
    fireEvent.click(screen.getByRole("tab", { name: "Folded" }));
    expect(labels()).toEqual(["Back", "New thread", "More"]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(layoutSet).toHaveBeenCalledOnce());
    expect(saved(layoutSet).unfolded.buttons.map((button) => button.label)).toEqual(["New thread", "More"]);
  });

  it("opens a new button for editing, with its name ready to type", async () => {
    await renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const row = screen.getAllByRole("listitem", { name: "New thread" }).at(-1) as HTMLElement;
    const name = within(row).getByLabelText("Name");
    expect(document.activeElement).toBe(name);
    expect(within(row).getByRole("button", { name: "Edit New thread" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("adds a button, and gives it a name, a symbol and an action", async () => {
    const { layoutSet } = await renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const row = screen.getAllByRole("listitem", { name: "New thread" }).at(-1) as HTMLElement;
    fireEvent.change(within(row).getByLabelText("Action"), { target: { value: "openProject" } });
    fireEvent.change(within(row).getByLabelText("Project"), { target: { value: "p1" } });
    // Picking the project names the button after it.
    expect((within(row).getByLabelText("Name") as HTMLInputElement).value).toBe("Acme Web");
    fireEvent.change(within(row).getByLabelText("Name"), { target: { value: "Acme" } });
    fireEvent.click(within(row).getByRole("button", { name: "Symbol: Folder" }));
    fireEvent.click(screen.getByRole("radio", { name: "Star" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(layoutSet).toHaveBeenCalledOnce());
    expect(saved(layoutSet).folded.buttons.at(-1)).toEqual({ id: "newThread", label: "Acme", icon: "Star", action: { kind: "openProject", projectId: "p1" } });
  });

  it("edits a menu's items", async () => {
    const { layoutSet } = await renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Edit More" }));
    const items = screen.getByRole("list", { name: "Menu items" });
    fireEvent.click(within(items).getByRole("button", { name: "Remove Reload bb" }));
    fireEvent.click(screen.getByRole("button", { name: "Add menu item" }));
    const added = within(items).getAllByRole("listitem").at(-1) as HTMLElement;
    fireEvent.change(within(added).getByLabelText("Action"), { target: { value: "bbCommand" } });
    fireEvent.change(within(added).getByLabelText("Command, after bb"), { target: { value: `herald say "hello there"` } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(layoutSet).toHaveBeenCalledOnce());
    const more = saved(layoutSet).folded.buttons[2]?.action;
    expect(more?.kind === "menu" && more.items.map((item) => item.action)).toEqual([
      { kind: "recentThreads", count: 5 },
      { kind: "forward" },
      { kind: "bbCommand", args: ["herald", "say", "hello there"] },
    ]);
  });

  it("lists every command, plugins' subcommands and bb's own, narrows it as you type, and names the button after the pick", async () => {
    const { layoutSet } = await renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const row = screen.getAllByRole("listitem", { name: "New thread" }).at(-1) as HTMLElement;
    fireEvent.change(within(row).getByLabelText("Action"), { target: { value: "bbCommand" } });
    const box = within(row).getByRole("combobox", { name: "Command, after bb" });
    fireEvent.focus(box);
    const options = async () => within(await within(row).findByRole("listbox", { name: "bb commands" })).getAllByRole("option").map((option) => option.querySelector("span")?.textContent);
    // Every command, once the listing is in: not one, as the datalist showed with a command already typed.
    await vi.waitFor(async () =>
      expect(await options()).toEqual(["bb agent-graph", "bb agent-graph show", "bb git", "bb git status", "bb git viewed list", "bb thread list", "bb plugin reload"]),
    );
    fireEvent.change(box, { target: { value: "viewed" } });
    expect(await options()).toEqual(["bb git viewed list"]);
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.focus(box);
    fireEvent.click(within(row).getByRole("option", { name: /bb git status/ }));
    expect((box as HTMLInputElement).value).toBe("git status");
    expect((within(row).getByLabelText("Name") as HTMLInputElement).value).toBe("git status");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(layoutSet).toHaveBeenCalledOnce());
    expect(saved(layoutSet).folded.buttons.at(-1)).toMatchObject({ label: "git status", action: { kind: "bbCommand", args: ["git", "status"] } });
  });

  it("keeps a name the owner typed when a command is picked", async () => {
    await renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const row = screen.getAllByRole("listitem", { name: "New thread" }).at(-1) as HTMLElement;
    fireEvent.change(within(row).getByLabelText("Action"), { target: { value: "bbCommand" } });
    fireEvent.change(within(row).getByLabelText("Name"), { target: { value: "Graph" } });
    const box = within(row).getByRole("combobox", { name: "Command, after bb" });
    fireEvent.focus(box);
    fireEvent.click(await within(row).findByRole("option", { name: /^bb agent-graph\s*Show a live graph/ }));
    expect((within(row).getByLabelText("Name") as HTMLInputElement).value).toBe("Graph");
  });

  it("offers bb's thread-menu actions to run on the open thread, and names the button after the one picked", async () => {
    await renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Edit Back" }));
    const row = screen.getByRole("listitem", { name: "Back" });
    fireEvent.change(within(row).getByLabelText("Action"), { target: { value: "threadAction" } });
    expect(within(within(row).getByLabelText("Action from bb's thread menu")).getAllByRole("option").map((option) => option.textContent)).toEqual(["Pin"]);
    expect((within(row).getByLabelText("Name") as HTMLInputElement).value).toBe("Pin");
  });

  it("will not save a layout the rail could not draw, and says why", async () => {
    const { layoutSet } = await renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Edit Back" }));
    fireEvent.change(within(screen.getByRole("listitem", { name: "Back" })).getByLabelText("Name"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("alert").textContent).toMatch(/folded\.buttons\.0\.label/);
    expect(layoutSet).not.toHaveBeenCalled();
  });

  it("copies the other display's buttons, goes back to the default, and discards", async () => {
    const unfolded = { ...defaultLayout(), unfolded: { buttons: [{ id: "f", label: "Forward", icon: "ArrowRight", action: { kind: "forward" as const } }] } };
    await renderEditor({ layout: unfolded });
    fireEvent.click(screen.getByRole("button", { name: "Copy the unfolded buttons" }));
    expect(labels()).toEqual(["Forward"]);
    fireEvent.click(screen.getByRole("button", { name: "Back to the default buttons" }));
    expect(labels()).toEqual(["Back", "New thread", "More"]);
    fireEvent.click(screen.getByRole("button", { name: "Copy the unfolded buttons" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(labels()).toEqual(["Back", "New thread", "More"]);
  });

  it("exports the layout to the clipboard, and imports one to save", async () => {
    const { slot, layoutSet } = await renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await vi.waitFor(() => expect(slot.inspection.experimental_clipboardWrites).toHaveLength(1));
    expect(JSON.parse(slot.inspection.experimental_clipboardWrites[0]!.text)).toEqual(defaultLayout());

    fireEvent.click(screen.getByRole("button", { name: "Import…" }));
    const box = screen.getByLabelText(/A layout exported from Duo Rail/);
    fireEvent.change(box, { target: { value: "{ nope" } });
    expect(screen.getByRole("button", { name: "Use this layout" })).toHaveProperty("disabled", true);
    const imported: Layout = { version: 1, folded: { buttons: [{ id: "f", label: "Forward", icon: "ArrowRight", action: { kind: "forward" } }] }, unfolded: { buttons: [] } };
    fireEvent.change(box, { target: { value: JSON.stringify(imported) } });
    fireEvent.click(screen.getByRole("button", { name: "Use this layout" }));
    expect(labels()).toEqual(["Forward"]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(layoutSet).toHaveBeenCalledOnce());
    expect(saved(layoutSet)).toEqual(imported);
  });

  it("says when the saved layout could not be read", async () => {
    await renderEditor({ layout: defaultLayout(), problem: "The saved layout could not be read, so the rail shows the default: bad version" });
    expect(screen.getByRole("alert").textContent).toContain("could not be read");
    expect(labels()).toEqual(["Back", "New thread", "More"]);
  });
});

describe("the symbol picker", () => {
  const openRow = (name: string) => {
    fireEvent.click(screen.getByRole("button", { name: `Edit ${name}` }));
    return screen.getAllByRole("listitem", { name }).at(0) as HTMLElement;
  };
  /** Opens the row's symbol popover and returns its grid. */
  const openPicker = (row: HTMLElement, current: string) => {
    fireEvent.click(within(row).getByRole("button", { name: `Symbol: ${current}` }));
    return screen.getByRole("radiogroup", { name: "Symbol" });
  };
  const search = (value: string) => fireEvent.change(screen.getByRole("searchbox", { name: "Search symbols" }), { target: { value } });

  it("shows the symbol as a button right of the Name box, and the grid only once it is pressed", async () => {
    await renderEditor();
    const row = openRow("Back");
    const name = within(row).getByLabelText("Name");
    const trigger = within(row).getByRole("button", { name: "Symbol: ArrowLeft" });
    expect(trigger.getAttribute("title")).toBe("ArrowLeft");
    // One row: the box first, then the symbol.
    const line = trigger.closest(".flex.items-start") as HTMLElement;
    expect(line.contains(name)).toBe(true);
    expect(name.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Symbol" })).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    openPicker(row, "ArrowLeft");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("offers every symbol bb draws, New thread first, the current one checked and named", async () => {
    await renderEditor();
    const grid = openPicker(openRow("Back"), "ArrowLeft");
    const radios = within(grid).getAllByRole("radio");
    expect(radios).toHaveLength(ICON_CHOICES.length);
    expect(radios[0]?.getAttribute("aria-label")).toBe("New thread");
    const checked = radios.filter((radio) => radio.getAttribute("aria-checked") === "true");
    expect(checked.map((radio) => radio.getAttribute("aria-label"))).toEqual(["ArrowLeft"]);
    // A tooltip with its name, and the editor's touch size on a phone.
    expect(checked[0]?.getAttribute("title")).toBe("ArrowLeft");
    expect(checked[0]?.className).toContain("max-md:pointer-coarse:size-11");
  });

  it("narrows to the names holding what is typed, whatever its case, and says when none does", async () => {
    await renderEditor();
    const grid = openPicker(openRow("Back"), "ArrowLeft");
    search("gitPULL");
    const names = within(grid).getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"));
    expect(names).toEqual(["GitPullRequest", "GitPullRequestArrow", "GitPullRequestClosed", "GitPullRequestDraft"]);
    search("no such symbol");
    expect(within(grid).queryAllByRole("radio")).toHaveLength(0);
    expect(within(grid).getByText("No symbol is called that.")).toBeTruthy();
  });

  it("closes on a pick, shows the pick on the button, and saves it", async () => {
    const { layoutSet } = await renderEditor();
    const row = openRow("Back");
    const grid = openPicker(row, "ArrowLeft");
    search("rocket");
    expect(within(grid).queryAllByRole("radio")).toHaveLength(0);
    search("brain");
    fireEvent.click(within(grid).getByRole("radio", { name: "AiBrain01" }));
    await vi.waitFor(() => expect(screen.queryByRole("radiogroup", { name: "Symbol" })).toBeNull());
    expect(within(row).getByRole("button", { name: "Symbol: AiBrain01" })).toBeTruthy();
    // Opened again, the search starts empty and the pick is the one checked.
    const again = openPicker(row, "AiBrain01");
    expect((screen.getByRole("searchbox", { name: "Search symbols" }) as HTMLInputElement).value).toBe("");
    expect(within(again).getByRole("radio", { name: "AiBrain01" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(layoutSet).toHaveBeenCalledOnce());
    expect(saved(layoutSet).folded.buttons[0]).toMatchObject({ label: "Back", icon: "AiBrain01" });
  });

  it("still shows a saved symbol bb does not have, selected, and keeps it on save", async () => {
    const layout = defaultLayout();
    layout.folded.buttons[0] = { ...layout.folded.buttons[0]!, icon: "Rocket" };
    const { layoutSet } = await renderEditor({ layout });
    const row = openRow("Back");
    const radios = within(openPicker(row, "Rocket (not one of bb's symbols)")).getAllByRole("radio");
    expect(radios[1]?.getAttribute("aria-label")).toBe("Rocket (not one of bb's symbols)");
    expect(radios[1]?.getAttribute("aria-checked")).toBe("true");
    expect(radios).toHaveLength(ICON_CHOICES.length + 1);
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search symbols" }), { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("radiogroup", { name: "Symbol" })).toBeNull());
    fireEvent.change(within(row).getByLabelText("Name"), { target: { value: "Go back" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(layoutSet).toHaveBeenCalledOnce());
    expect(saved(layoutSet).folded.buttons[0]).toMatchObject({ label: "Go back", icon: "Rocket" });
  });

  it("checks New thread on the New thread button", async () => {
    await renderEditor();
    const grid = openPicker(openRow("New thread"), "New thread");
    const checked = within(grid).getAllByRole("radio").filter((radio) => radio.getAttribute("aria-checked") === "true");
    expect(checked.map((radio) => radio.getAttribute("aria-label"))).toEqual(["New thread"]);
    expect(ICON_CHOICES[0]).toBe(NEW_THREAD_ICON);
  });
});

describe("revealWithin", () => {
  const grid = (scrollTop: number) => ({ scrollTop, clientHeight: 200 }) as HTMLElement;
  const cell = (offsetTop: number) => ({ offsetTop, offsetHeight: 40 }) as HTMLElement;

  it("scrolls only the grid, centring a choice that is out of view", () => {
    const below = grid(0);
    revealWithin(below, cell(1000));
    expect(below.scrollTop).toBe(1000 - 80);
    const above = grid(900);
    revealWithin(above, cell(100));
    expect(above.scrollTop).toBe(20);
  });

  it("leaves a choice already in view where it is", () => {
    const view = grid(100);
    revealWithin(view, cell(150));
    expect(view.scrollTop).toBe(100);
    const top = grid(0);
    revealWithin(top, cell(0));
    expect(top.scrollTop).toBe(0);
  });
});
