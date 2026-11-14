// @vitest-environment jsdom
/**
 * The speech hooks in Herald's settings: each of bb's machines with its two
 * commands, saved per machine, and what this window says about running them.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RpcContract } from "../shared/contract";
import type { MachineHooks, SpeechHooks } from "../shared/speech-hooks";
import { SpeechHooksSection } from "./speech-hooks-section";

const HOSTS = [
  { id: "host_mac", name: "Studio Mac", lifecycle: { phase: "active" } },
  { id: "host_laptop", name: "Laptop", lifecycle: { phase: "active" } },
  { id: "host_gone", name: "Old box", lifecycle: { phase: "destroyed" } },
];

function backend(initial: SpeechHooks) {
  let hooks = initial;
  const saves: Array<{ hostId: string } & MachineHooks> = [];
  const handlers = {
    "hooks.list": () => ({ hooks }),
    "hooks.set": (input: { hostId: string } & MachineHooks) => {
      saves.push(input);
      const { [input.hostId]: _old, ...rest } = hooks;
      hooks = input.before === "" && input.after === "" ? rest : { ...rest, [input.hostId]: { before: input.before, after: input.after } };
      return { hooks };
    },
  };
  return { handlers: handlers as never, saves };
}

function render(initial: SpeechHooks, sdk: object = { hosts: { list: async () => HOSTS } }) {
  const { handlers, saves } = backend(initial);
  renderSlot<object, RpcContract>({ component: SpeechHooksSection }, {}, { rpc: handlers, sdk: sdk as never });
  return { saves };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { bbDesktop?: unknown }).bbDesktop;
});

describe("Speech hooks settings", () => {
  it("lists each active machine with empty hooks by default, and saves one machine's", async () => {
    const { saves } = render({});
    const before = (await screen.findByLabelText("Before speaking on Studio Mac")) as HTMLTextAreaElement;
    expect(before.value).toBe("");
    expect((screen.getByLabelText("After speaking on Laptop") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText("Old box")).toBeNull();
    const save = screen.getByText("Save hooks for Studio Mac").closest("button") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(before, { target: { value: "osascript -e 'tell application \"Music\" to pause'" } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(saves).toEqual([{ hostId: "host_mac", before: "osascript -e 'tell application \"Music\" to pause'", after: "" }]),
    );
  });

  it("shows a machine's saved hooks, and one that is no longer bb's so it can be cleared", async () => {
    render({ host_mac: { before: "pause", after: "resume" }, host_old: { before: "x", after: "" } });
    expect(((await screen.findByLabelText("After speaking on Studio Mac")) as HTMLTextAreaElement).value).toBe("resume");
    expect(((await screen.findByLabelText("Before speaking on host_old")) as HTMLTextAreaElement).value).toBe("x");
    expect(screen.getByText("no longer one of bb's machines")).toBeTruthy();
  });

  it("says a browser tab runs no hooks", async () => {
    render({});
    await screen.findByText("This is a browser tab, which runs no hooks; bb's desktop app does.");
  });

  it("marks this machine in bb's desktop app, found through its host daemon", async () => {
    (window as { bbDesktop?: unknown }).bbDesktop = {};
    const fetchStatus = vi.fn(async () => ({
      ok: true,
      json: async () => ({ hostId: "host_laptop", connected: true, serverUrl: window.location.origin }),
    }));
    vi.stubGlobal("fetch", fetchStatus);
    render({}, { hosts: { list: async () => HOSTS }, system: { config: async () => ({ localHelperPorts: [38887] }) } });
    await screen.findByText("This window runs the hooks of the machine marked “this machine”.");
    expect(fetchStatus).toHaveBeenCalledWith("http://127.0.0.1:38887/status", expect.anything());
    const laptop = (await screen.findByText("Laptop")).closest("p");
    expect(laptop?.textContent).toContain("this machine");
  });

  it("says when the desktop app's machine is not one of bb's", async () => {
    (window as { bbDesktop?: unknown }).bbDesktop = {};
    render({}, { hosts: { list: async () => HOSTS }, system: { config: async () => ({ localHelperPorts: [] }) } });
    await screen.findByText("This machine is not one of bb's machines for this server, so no hook runs in this window.");
  });
});
