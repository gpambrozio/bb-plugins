// @vitest-environment jsdom
/**
 * The first-run guide's folder browser, and the guide's Browse button: the in-dialog browser over bb's
 * host listing anywhere but the desktop app on bb's own machine, where the system picker opens instead.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expandHome, FolderBrowser, folderNameProblem, joinPath, openNearest, parentOf, type FolderListing } from "./folder-browser";
import { IntroDialog } from "./intro";

const localHost = vi.hoisted(() => ({ desktop: false, hostId: null as string | null }));

vi.mock("./local-host", () => ({
  isDesktopApp: () => localHost.desktop,
  findLocalHostId: async () => localHost.hostId,
}));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn(), dismiss: vi.fn() }) }));

afterEach(() => {
  cleanup();
  localHost.desktop = false;
  localHost.hostId = null;
});

const HOME = "/Users/me";

/** A machine's folders: each folder's subfolders by name, and one file to leave out. */
function fakeMachine(initial: Record<string, string[]>) {
  const folders = new Map(Object.entries(initial).map(([path, names]) => [path, [...names]]));
  const directory = vi.fn(async ({ path }: { hostId: string; path?: string }) => {
    const at = path ?? HOME;
    const names = folders.get(at);
    if (names === undefined) throw new Error(`Path "${at}" does not exist`);
    return {
      directory: at,
      parent: parentOf(at),
      roots: ["/"],
      entries: [
        { kind: "file" as const, name: "notes.txt", path: joinPath(at, "notes.txt") },
        ...names.map((name) => ({ kind: "directory" as const, name, path: joinPath(at, name) })),
      ],
    };
  });
  const mkdir = vi.fn(async ({ path }: { hostId?: string; path: string; recursive?: boolean }) => {
    if (folders.has(path)) throw new Error(`EEXIST: ${path}`);
    const parent = parentOf(path)!;
    folders.get(parent)!.push(path.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
    folders.set(path, []);
    return { ok: true as const };
  });
  return { folders, directory, mkdir };
}

function shownFolder(): string | null {
  return screen.getByRole("group", { name: "Folder browser" }).querySelector(".font-mono")?.textContent ?? null;
}

function folderButtons(): string[] {
  return within(screen.getByRole("list", { name: "Folders" }))
    .queryAllByRole("button")
    .map((button) => button.textContent ?? "");
}

describe("path helpers", () => {
  it("expands ~ under the machine's home folder and walks up to the root", () => {
    expect(expandHome("~", HOME)).toBe(HOME);
    expect(expandHome(" ~/FirstMate ", HOME)).toBe(`${HOME}/FirstMate`);
    expect(expandHome("/srv/fm", HOME)).toBe("/srv/fm");
    expect(parentOf("/Users/me/fm/")).toBe("/Users/me");
    expect(parentOf("/Users")).toBe("/");
    expect(parentOf("/")).toBeNull();
    expect(joinPath("/", "srv")).toBe("/srv");
  });

  it("takes one plain name for a new folder", () => {
    expect(folderNameProblem("FirstMate")).toBeNull();
    expect(folderNameProblem("  ")).not.toBeNull();
    expect(folderNameProblem("..")).not.toBeNull();
    expect(folderNameProblem("a/b")).not.toBeNull();
  });

  it("opens at the typed folder's nearest existing one, and at home for anything else", async () => {
    const machine = fakeMachine({ [HOME]: ["code"], [`${HOME}/code`]: [], "/": ["Users"], "/Users": ["me"] });
    const list = async (path?: string): Promise<FolderListing> => {
      const listing = await machine.directory({ hostId: "h", ...(path === undefined ? {} : { path }) });
      return { directory: listing.directory, parent: listing.parent, folders: [] };
    };
    expect((await openNearest(list, "~/code/fm/deeper")).directory).toBe(`${HOME}/code`);
    expect((await openNearest(list, "~/FirstMate")).directory).toBe(HOME);
    expect((await openNearest(list, "/Users")).directory).toBe("/Users");
    expect((await openNearest(list, "FirstMate")).directory).toBe(HOME);
  });
});

describe("the folder browser", () => {
  it("lists only folders, goes in and up, and hands back the folder shown", async () => {
    const machine = fakeMachine({ [HOME]: ["code", "Documents"], [`${HOME}/code`]: ["app"], "/Users": ["me"] });
    const onPick = vi.fn();
    renderSlot(
      { component: () => <FolderBrowser hostId="host_server" machine="Server" typed="~/FirstMate" onPick={onPick} onClose={() => {}} /> },
      {},
      { sdk: { hosts: { directory: machine.directory }, files: { mkdir: machine.mkdir } } },
    );
    await waitFor(() => expect(shownFolder()).toBe(HOME));
    expect(folderButtons()).toEqual(["code", "Documents"]);
    expect(machine.directory.mock.calls.every(([args]) => args.hostId === "host_server")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "code" }));
    await waitFor(() => expect(shownFolder()).toBe(`${HOME}/code`));
    expect(folderButtons()).toEqual(["app"]);

    fireEvent.click(screen.getByRole("button", { name: "Up one folder" }));
    await waitFor(() => expect(shownFolder()).toBe(HOME));
    fireEvent.click(screen.getByRole("button", { name: "Up one folder" }));
    await waitFor(() => expect(shownFolder()).toBe("/Users"));

    fireEvent.click(screen.getByRole("button", { name: "me" }));
    await waitFor(() => expect(shownFolder()).toBe(HOME));
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    expect(onPick).toHaveBeenCalledWith(HOME);
  });

  it("makes a new folder where it is and opens it; a bad name or a failure makes nothing", async () => {
    const machine = fakeMachine({ [HOME]: ["code"], [`${HOME}/code`]: [] });
    const onPick = vi.fn();
    renderSlot(
      { component: () => <FolderBrowser hostId="host_server" machine="Server" typed="~" onPick={onPick} onClose={() => {}} /> },
      {},
      { sdk: { hosts: { directory: machine.directory }, files: { mkdir: machine.mkdir } } },
    );
    await waitFor(() => expect(shownFolder()).toBe(HOME));

    fireEvent.click(screen.getByRole("button", { name: /New folder/ }));
    const name = screen.getByRole("textbox", { name: "New folder name" });
    fireEvent.change(name, { target: { value: "../escape" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("alert").textContent).toMatch(/without a \//);
    expect(machine.mkdir).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: "code" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/EEXIST/));
    expect(shownFolder()).toBe(HOME);

    fireEvent.change(name, { target: { value: " FirstMate " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(shownFolder()).toBe(`${HOME}/FirstMate`));
    expect(machine.mkdir).toHaveBeenLastCalledWith({ hostId: "host_server", path: `${HOME}/FirstMate`, recursive: false });
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    expect(onPick).toHaveBeenCalledWith(`${HOME}/FirstMate`);
  });
});

describe("the guide's Browse button", () => {
  function sdkFakes(machine: ReturnType<typeof fakeMachine>, pickFolder = vi.fn(async () => ({ path: null as string | null }))) {
    return {
      system: { config: async () => ({ primaryHostId: "host_server", localHelperPorts: [] }) },
      hosts: {
        list: async () => [
          { id: "host_server", name: "Server", status: "connected" },
          { id: "host_laptop", name: "Laptop", status: "connected" },
        ],
        directory: machine.directory,
        pickFolder,
      },
      files: { mkdir: machine.mkdir },
      providers: { list: async () => [], models: async () => ({ models: [] }) },
    } as never;
  }

  function homeField(): HTMLInputElement {
    return screen.getByRole("textbox", { name: "Home folder" }) as HTMLInputElement;
  }

  it("browses the server's folders in the dialog, and the folder picked fills the home field", async () => {
    const machine = fakeMachine({ [HOME]: ["code"], [`${HOME}/code`]: [] });
    const pickFolder = vi.fn(async () => ({ path: "/never" }));
    renderSlot(
      { component: () => <IntroDialog onClose={() => {}} initialHome="~/FirstMate" onStarted={() => {}} /> },
      {},
      { sdk: sdkFakes(machine, pickFolder) },
    );
    const browse = await screen.findByRole("button", { name: "Browse…" });
    fireEvent.click(browse);
    await waitFor(() => expect(shownFolder()).toBe(HOME));
    fireEvent.click(screen.getByRole("button", { name: "code" }));
    await waitFor(() => expect(shownFolder()).toBe(`${HOME}/code`));
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));

    expect(homeField().value).toBe(`${HOME}/code`);
    expect(screen.queryByRole("group", { name: "Folder browser" })).toBeNull();
    expect(pickFolder).not.toHaveBeenCalled();
    // Typing still works: the field is the path the guide sends, browsed or typed.
    fireEvent.change(homeField(), { target: { value: "~/Elsewhere" } });
    expect(homeField().value).toBe("~/Elsewhere");
  });

  it("opens the system picker in the desktop app on bb's own machine, and the browser if it cannot", async () => {
    localHost.desktop = true;
    localHost.hostId = "host_server";
    const machine = fakeMachine({ [HOME]: [] });
    const pickFolder = vi.fn(async () => ({ path: "/Users/me/Picked" as string | null }));
    renderSlot(
      { component: () => <IntroDialog onClose={() => {}} initialHome="~/FirstMate" onStarted={() => {}} /> },
      {},
      { sdk: sdkFakes(machine, pickFolder) },
    );
    const browse = await screen.findByRole("button", { name: "Browse…" });
    // The machine lookup is async: wait until Browse would pick natively.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(browse);
    await waitFor(() => expect(homeField().value).toBe("/Users/me/Picked"));
    expect(pickFolder).toHaveBeenCalledWith({ hostId: "host_server", clientHostId: "host_server" });
    expect(screen.queryByRole("group", { name: "Folder browser" })).toBeNull();

    pickFolder.mockRejectedValueOnce(new Error("no picker"));
    fireEvent.click(browse);
    await waitFor(() => expect(shownFolder()).toBe(HOME));
  });
});
