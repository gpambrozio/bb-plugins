// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../shared/config";

let config: Config = { projectNames: {}, hosts: {} };
const call = vi.fn();
const refetch = vi.fn(async () => undefined);

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_Icon: () => null,
  experimental_useRpcQuery: () => ({ data: config, error: null, refetch }),
  useRpc: () => ({ call }),
  useSdk: () => SDK,
}));

const SDK = {
  hosts: {
    list: async () => [
      { id: "host_mini", name: "MacMini" },
      { id: "host_win", name: "Windows Box" },
    ],
  },
  projects: {
    list: async () => [
      { id: "proj_a", name: "FirstMate" },
      { id: "proj_b", name: "FirstMate" },
      { id: "proj_c", name: "Gallager" },
      { id: "proj_a", name: "FirstMate" },
    ],
  },
};

const { SettingsSection } = await import("./settings-section");

afterEach(cleanup);

beforeEach(() => {
  config = { projectNames: {}, hosts: {} };
  call.mockReset();
  call.mockImplementation(async (method: string, input: Record<string, unknown>) => {
    if (method === "hosts.check") return input.hostId === "host_mini" ? { ok: true, message: "Ready" } : { ok: false, message: "this machine runs Windows" };
    return config;
  });
});

describe("the settings page", () => {
  it("lists each project name once, with no machine or folder", async () => {
    render(<SettingsSection />);
    await screen.findByText("Gallager");
    expect(screen.getAllByText("FirstMate")).toHaveLength(1);
    expect(screen.queryByText(/~\//)).toBeNull();
  });

  it("switches a name for every project with it", async () => {
    render(<SettingsSection />);
    fireEvent.click(await screen.findByLabelText("FirstMate"));
    await waitFor(() => expect(call).toHaveBeenCalledWith("config.setProjectName", { name: "FirstMate", on: true }));
  });

  it("selects every project name, and none", async () => {
    render(<SettingsSection />);
    await screen.findByText("Gallager");
    fireEvent.click(screen.getByRole("button", { name: "Select all projects" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("config.setProjectNames", { names: ["FirstMate", "Gallager"], on: true }));
    fireEvent.click(screen.getByRole("button", { name: "Select no projects" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("config.setProjectNames", { names: ["FirstMate", "Gallager"], on: false }));
  });

  it("turns on only ready machines with Select all, and shows why the others stay off", async () => {
    render(<SettingsSection />);
    await screen.findByText("Windows Box");
    fireEvent.click(screen.getByRole("button", { name: "Select all machines" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("config.setHosts", { hostIds: ["host_mini"], on: true }));
    expect(await screen.findByText("this machine runs Windows")).toBeTruthy();
    expect(call).not.toHaveBeenCalledWith("config.setHosts", expect.objectContaining({ hostIds: expect.arrayContaining(["host_win"]), on: true }));
  });

  it("turns every machine off with Select none", async () => {
    config = { projectNames: {}, hosts: { host_mini: true } };
    render(<SettingsSection />);
    const row = (await screen.findByText("MacMini")).closest("div")!.parentElement!;
    expect(within(row).getByRole("checkbox").getAttribute("data-state")).toBe("checked");
    fireEvent.click(screen.getByRole("button", { name: "Select no machines" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("config.setHosts", { hostIds: ["host_mini", "host_win"], on: false }));
  });
});
