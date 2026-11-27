// @vitest-environment jsdom
/**
 * The settings' Open the script button: bb's settings page has no file panel, so the request goes to the Voice
 * page, which opens the hook file in its own panel through bb's file access. Nothing reads the file.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { rpcContract } from "../server";
import { HOOK_OPEN_WAIT_MS, hookOpen, makeHookOpenRequest } from "./hook-file";
import { VoiceHooksSection, hookFileTarget } from "./hooks-section";
import { HookFileOpener } from "./page";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { info: vi.fn(), dismiss: vi.fn() }) }));

type Rpc = PluginRpcTestHandlers<typeof rpcContract>;

const PATH = "/Users/someone/.config/voice-pilot/hook.sh";

function rpc(): Rpc {
  return {
    "hooks.status": async () => ({
      machines: [
        { hostId: "host_mac", name: "Studio Mac", status: { present: true, executable: true, path: PATH } },
        { hostId: "host_none", name: "Laptop", status: { present: false, executable: false, path: "/Users/someone/.config/voice-pilot/hook" } },
        { hostId: "host_off", name: "Offline box", status: null },
      ],
    }),
  } as Partial<Rpc> as Rpc;
}

beforeEach(() => {
  hookOpen.take();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("which machines offer the script", () => {
  it("only one whose hook file is there and says where", () => {
    expect(hookFileTarget({ hostId: "h", name: "M", status: { present: true, executable: false, path: PATH } })).toEqual({ kind: "host", hostId: "h", path: PATH });
    expect(hookFileTarget({ hostId: "h", name: "M", status: { present: false, executable: false, path: PATH } })).toBeNull();
    expect(hookFileTarget({ hostId: "h", name: "M", status: null })).toBeNull();
    // A host entry from before the path was reported.
    expect(hookFileTarget({ hostId: "h", name: "M", status: { present: true, executable: true } })).toBeNull();
  });
});

describe("the settings' Open the script", () => {
  it("opens the file in bb's panel directly where the surface has one", async () => {
    const view = renderSlot({ component: VoiceHooksSection }, {}, { rpc: rpc(), openFilePreview: () => true });
    const buttons = await screen.findAllByRole("button", { name: "Open the script" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(view.navigateCalls).toEqual([{ method: "experimental_openFilePreview", options: { target: { kind: "host", hostId: "host_mac", path: PATH }, location: null } }]);
    expect(hookOpen.wanted).toBeNull();
  });

  it("hands it to the Voice page when the settings page has no file panel, and the page opens it there", async () => {
    const settings = renderSlot({ component: VoiceHooksSection }, {}, { rpc: rpc(), openFilePreview: () => false });
    fireEvent.click(await screen.findByRole("button", { name: "Open the script" }));
    expect(settings.navigateCalls.map((call) => call.method)).toEqual(["experimental_openFilePreview", "toPluginPanel"]);
    expect(settings.navigateCalls[1]).toMatchObject({ path: "voice" });
    expect(hookOpen.wanted).toMatchObject({ target: { hostId: "host_mac", path: PATH }, machine: "Studio Mac" });

    const page = renderSlot({ component: HookFileOpener }, {}, { openFilePreview: () => true });
    await waitFor(() => expect(page.navigateCalls).toEqual([{ method: "experimental_openFilePreview", options: { target: { kind: "host", hostId: "host_mac", path: PATH }, location: null } }]));
    expect(hookOpen.wanted).toBeNull();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("says where the file is when bb cannot open it on the Voice page either", async () => {
    hookOpen.ask({ kind: "host", hostId: "host_mac", path: PATH }, "Studio Mac");
    renderSlot({ component: HookFileOpener }, {}, { openFilePreview: () => false });
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(`bb could not open the hook script. It is ${PATH} on Studio Mac.`));
  });
});

describe("a request to open the script", () => {
  it("is taken once, and a stale one is dropped", () => {
    let now = 0;
    const request = makeHookOpenRequest(() => now);
    request.ask({ kind: "host", hostId: "h", path: PATH }, "M");
    expect(request.take()).toMatchObject({ machine: "M" });
    expect(request.take()).toBeNull();
    request.ask({ kind: "host", hostId: "h", path: PATH }, "M");
    now = HOOK_OPEN_WAIT_MS + 1;
    expect(request.take()).toBeNull();
    expect(request.wanted).toBeNull();
  });
});
