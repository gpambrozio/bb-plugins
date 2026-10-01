// @vitest-environment jsdom
/**
 * The page against a fake server: an adopted job lists with its status, its
 * detail shows its runs and log, opening a failing one acknowledges it, and
 * Follow reads only what a relayed change appended.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { LOG_CHANGED } from "../shared/channels";
import type { RpcContract } from "../shared/contract";
import type { Job, LogChunk } from "../shared/jobs";
import { FailingAccessory } from "./health";
import { JobsPanel } from "./jobs-panel";

beforeAll(() => {
  // jsdom has no matchMedia; the compact-viewport hook asks it.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => cleanup());

const adopted: Job = {
  id: "nightly-report",
  label: "com.paseo-plugins.launchd-jobs.nightly-report",
  name: "Nightly report",
  command: "make-report --all",
  cwd: null,
  schedule: { type: "cron", expression: "0 2 * * *", description: "At 02:00", entries: [{ minute: 0, hour: 2 }] },
  managed: true,
  dataDir: "/paseo/plugin-data/launchd-jobs",
  adopted: true,
  readOnlyData: false,
  loaded: true,
  disabled: false,
  running: false,
  pid: null,
  runs: 4,
  lastExitCode: 1,
  recentRuns: [
    { startedAt: "2026-01-02T02:00:00Z", finishedAt: "2026-01-02T02:00:01Z", exitCode: 1, durationMs: 1000 },
    { startedAt: "2026-01-01T02:00:00Z", finishedAt: "2026-01-01T02:00:01Z", exitCode: 0, durationMs: 1000 },
  ],
  plistPath: "/agents/com.paseo-plugins.launchd-jobs.nightly-report.plist",
  logPath: "/paseo/plugin-data/launchd-jobs/logs/nightly-report.log",
  problem: null,
};

/** Handlers for the methods a test drives; any other method rejects, as an unstubbed one does. */
function stubs(handlers: Partial<PluginRpcTestHandlers<RpcContract>>): PluginRpcTestHandlers<RpcContract> {
  return handlers as PluginRpcTestHandlers<RpcContract>;
}

function chunk(text: string, next: number): LogChunk {
  return { text, pending: "", truncated: false, reset: false, next, path: adopted.logPath };
}

describe("the Scheduled jobs page", () => {
  it("lists an adopted job, opens it with its runs and log, acknowledges its failure, and follows its log", async () => {
    const appended = "=== 2026-01-03T02:00:00Z start\nlive line\n";
    const view = renderSlot<PluginNavPanelProps, RpcContract>({ component: JobsPanel }, { subPath: "" }, {
      rpc: stubs({
        hosts: () => ({ primaryHostId: "mini", hosts: [{ id: "mini", name: "Mini" }] }),
        list: () => ({ supported: true, jobs: [adopted], launchAgentsDir: "/agents" }),
        log: ({ from }) => (from === undefined ? chunk("report failed\n", 14) : chunk(appended, 14 + appended.length)),
        acknowledge: () => ({}),
        follow: () => ({ expiresInMs: 45_000 }),
        unfollow: () => ({}),
        health: () => ({ failing: [], checkedAt: 1 }),
      }),
    });

    fireEvent.click(await screen.findByText("Nightly report"));
    expect(screen.getAllByText("Failed (exit 1)").length).toBeGreaterThan(0);
    expect(await screen.findByText(/Made by the Paseo plugin/)).toBeTruthy();
    expect(screen.getAllByText("exit 0")).toHaveLength(1);
    await screen.findByText(/report failed/);
    await waitFor(() => expect(view.rpcCalls.some((call) => call.method === "acknowledge")).toBe(true));

    fireEvent.click(screen.getByText("Follow"));
    await waitFor(() => expect(view.rpcCalls.some((call) => call.method === "follow")).toBe(true));
    await view.emitRealtime(LOG_CHANGED, { hostId: "mini", id: "nightly-report" });
    await screen.findByText(/live line/);
    const reads = view.rpcCalls.filter((call) => call.method === "log").map((call) => call.input);
    expect(reads).toContainEqual({ hostId: "mini", id: "nightly-report", from: 14 });

    fireEvent.click(screen.getByText("Stop following"));
    await waitFor(() => expect(view.rpcCalls.some((call) => call.method === "unfollow")).toBe(true));
  });

  it("drops a save that answers after the user switched Macs, and never acts on the other Mac's job of the same name", async () => {
    window.localStorage.clear();
    let finishSave: (job: Job) => void = () => {};
    const other: Job = { ...adopted, name: "Same slug elsewhere", adopted: false, recentRuns: [adopted.recentRuns[0]!] };
    const view = renderSlot<PluginNavPanelProps, RpcContract>({ component: JobsPanel }, { subPath: "" }, {
      rpc: stubs({
        hosts: () => ({ primaryHostId: "mini", hosts: [{ id: "mini", name: "Mini" }, { id: "laptop", name: "Laptop" }] }),
        list: ({ hostId }) => ({ supported: true, jobs: [hostId === "mini" ? adopted : other], launchAgentsDir: "/agents" }),
        log: () => chunk("", 0),
        acknowledge: () => ({}),
        update: () => new Promise<Job>((resolve) => (finishSave = resolve)),
        health: () => ({ failing: [], checkedAt: 1 }),
      }),
    });

    // The page remembers the pane across mounts, so the job may already be open.
    fireEvent.click((await screen.findAllByText("Nightly report"))[0]!);
    fireEvent.click(await screen.findByText("Edit"));
    fireEvent.click(await screen.findByText("Save changes"));
    await waitFor(() => expect(view.rpcCalls.some((call) => call.method === "update")).toBe(true));

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "laptop" } });
    await screen.findByText("Same slug elsewhere");
    finishSave({ ...adopted, name: "Nightly report (edited)" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.queryByText("Nightly report (edited)")).toBeNull();
    expect(screen.getByText("Select a job, or create one.")).toBeTruthy();
    const onLaptop = view.rpcCalls.filter((call) => (call.input as { hostId?: string }).hostId === "laptop").map((call) => call.method);
    expect(onLaptop).toEqual(expect.not.arrayContaining(["acknowledge", "log"]));
  });

  it("shows the failing count beside the sidebar row, and updates it when the server publishes", async () => {
    const view = renderSlot<object, RpcContract>({ component: FailingAccessory }, {}, {
      rpc: stubs({ health: () => ({ failing: [], checkedAt: 1 }) }),
    });
    await waitFor(() => expect(view.rpcCalls.some((call) => call.method === "health")).toBe(true));
    expect(view.container.textContent).toBe("");

    await view.emitRealtime("health-changed", {
      failing: [
        { hostId: "mini", hostName: "Mini", id: "a", name: "A" },
        { hostId: "mini", hostName: "Mini", id: "b", name: "B" },
      ],
      checkedAt: 2,
    });
    expect(view.container.textContent).toBe("2 failing");
  });
});
