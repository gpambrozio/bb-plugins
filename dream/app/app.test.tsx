// @vitest-environment jsdom
/**
 * The app against a fake server: the page lists a project with why it is due, its warnings and a
 * waiting dry run, says the schedule is off, and shows a dream's summary in the history. Also the
 * boundaries a build does not check: the app takes the SDK root and the contract as types only, and
 * every icon it names is one bb draws.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";

import type { RpcContract } from "../shared/contract";
import { DEFAULT_CHOICES, type Overview, type RunRecord } from "../shared/contract-types";
import { DreamPage } from "./dream-page";
import { BB_ICON_NAMES } from "./testing/bb-icon-names";

afterEach(() => cleanup());

const root = join(import.meta.dirname, "..");
const appFiles = ["app.tsx", "shared/contract-types.ts", "shared/types.ts", "shared/gate.ts", "shared/format.ts", "shared/window.ts", "shared/filters.ts", "shared/line-diff.ts", ...readdirSync(join(root, "app")).filter((name) => /\.tsx?$/.test(name) && !name.includes(".test.")).map((name) => join("app", name))];

const overview: Overview = {
  host: { id: "host_1", name: "Studio", connected: true },
  hosts: [{ id: "host_1", name: "Studio", connected: true }],
  choices: DEFAULT_CHOICES,
  schedule: { enabled: false, windowStart: "01:00", windowEnd: "06:00", inWindow: false, nextChange: null, lastSweepAt: null },
  active: null,
  error: null,
  projects: [
    {
      projectId: "proj_app",
      name: "app",
      checkout: "/repos/app",
      enabled: true,
      memory: {
        dir: "/home/agent-memory/app",
        source: "projectSettings",
        configured: "~/agent-memory/app",
        defaultDir: "/home/.claude/projects/-repos-app/memory",
        autoMemoryEnabled: true,
        warnings: ["The default memory folder still holds 3 .md files; Dream leaves it alone."],
        files: 12,
        indexLines: 40,
        indexBytes: 3000,
      },
      gate: { due: false, code: "proposal-pending", reason: "A dry-run proposal waits to be applied or discarded.", lastDreamAt: null, baselineAt: null, sessionsSince: 9, daysSince: 3 },
      folders: 4,
      sessions: 20,
      inPlace: false,
      pendingProposal: { stamp: "20261117T010500000Z", createdAt: Date.UTC(2026, 10, 17, 1, 5), status: "ready", changes: { added: ["ci.md"], changed: ["build.md", "MEMORY.md"], deleted: [] }, dir: "/data/proposals/proj_app/20261117T010500000Z" },
      lastBackup: null,
    },
  ],
};

const run: RunRecord = {
  runId: "abc",
  projectId: "proj_app",
  projectName: "app",
  hostId: "host_1",
  mode: "dry-run",
  trigger: "schedule",
  startedAt: Date.UTC(2026, 10, 17, 1, 5),
  endedAt: Date.UTC(2026, 10, 17, 1, 15),
  outcome: "proposed",
  threadId: "thr_dream",
  changes: { added: ["ci.md"], changed: ["build.md"], deleted: [] },
  summary: "Merged the build notes. **CLAUDE.md to check:** none.",
  backup: null,
  proposal: "20261117T010500000Z",
  error: null,
};

function stubs(handlers: Partial<PluginRpcTestHandlers<RpcContract>>): PluginRpcTestHandlers<RpcContract> {
  return handlers as PluginRpcTestHandlers<RpcContract>;
}

describe("the Dream page", () => {
  it("shows a project's memory, why it is waiting, its warnings and dry run, and the history", async () => {
    const applied: string[] = [];
    renderSlot<PluginNavPanelProps, RpcContract>({ component: DreamPage }, { subPath: "" }, {
      rpc: stubs({
        overview: () => overview,
        history: () => [run],
        apply: ({ projectId }) => {
          applied.push(projectId);
          return { stamp: run.proposal as string, changes: run.changes as NonNullable<RunRecord["changes"]>, backup: "20261117T090000000Z" };
        },
      }),
    });
    expect(await screen.findByText("app")).toBeTruthy();
    expect(screen.getByText(/The schedule is off/)).toBeTruthy();
    expect(screen.getByText("Proposal waiting")).toBeTruthy();
    expect(screen.getByText("/home/agent-memory/app")).toBeTruthy();
    expect(screen.getByText(/still holds 3 .md files/)).toBeTruthy();
    expect(screen.getByText(/would update 2, add 1 memory files/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Dream now/ }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(applied).toEqual(["proj_app"]));

    fireEvent.click(screen.getByRole("tab", { name: /History/ }));
    fireEvent.click(await screen.findByRole("button", { expanded: false }));
    expect(await screen.findByText(/Merged the build notes/)).toBeTruthy();
    expect(screen.getByText("+ ci.md")).toBeTruthy();
  });
});

describe("the proposal view", () => {
  const diff = (baseChanged: boolean) => ({
    stamp: "20261117T010500000Z",
    createdAt: Date.UTC(2026, 10, 17, 1, 5),
    summary: "Fixed the build tool.",
    changes: { added: ["ci.md"], changed: ["MEMORY.md"], deleted: [] },
    files: [
      { path: "MEMORY.md", kind: "changed" as const, current: "- [Build](build.md) — make\n", proposed: "- [Build](build.md) — ninja\n", baseChanged, truncated: false },
      { path: "ci.md", kind: "added" as const, current: null, proposed: "ci runs nightly\n", baseChanged: false, truncated: false },
    ],
  });

  it("opens from the project, shows the counts and each file's diff, and applies from there", async () => {
    const applied: Array<string | undefined> = [];
    renderSlot<PluginNavPanelProps, RpcContract>({ component: DreamPage }, { subPath: "" }, {
      rpc: stubs({
        overview: () => overview,
        history: () => [],
        proposal: () => diff(false),
        apply: ({ stamp }) => {
          applied.push(stamp);
          return { stamp: stamp as string, changes: diff(false).changes, backup: "b" };
        },
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "View changes" }));
    expect(await screen.findByText(/1 changed, 1 added, 0 deleted/)).toBeTruthy();
    const index = screen.getByRole("table", { name: "Changes to MEMORY.md" });
    expect(index.querySelector('[data-kind="del"]')?.textContent).toContain("— make");
    expect(index.querySelector('[data-kind="add"]')?.textContent).toContain("— ninja");
    expect(screen.getByRole("table", { name: "Changes to ci.md" }).textContent).toContain("ci runs nightly");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(applied).toEqual(["20261117T010500000Z"]));
  });

  it("says plainly when the memory changed since the dry run, and turns Apply off", async () => {
    renderSlot<PluginNavPanelProps, RpcContract>({ component: DreamPage }, { subPath: "" }, {
      rpc: stubs({ overview: () => overview, history: () => [], proposal: () => diff(true) }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "View changes" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The memory has changed since this dry run: MEMORY.md");
    expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Discard" }).hasAttribute("disabled")).toBe(false);
  });
});

describe("the project filters", () => {
  const base = overview.projects[0];
  const projects = [
    { ...base, projectId: "p_due", name: "due-one", pendingProposal: null, gate: { ...base.gate, due: true, code: "due" as const, reason: "Due now." } },
    { ...base, projectId: "p_off", name: "switched-off", enabled: false, pendingProposal: null, gate: { ...base.gate, due: false, code: "off" as const, reason: "Turned off." } },
    { ...base, projectId: "p_empty", name: "no-memory", pendingProposal: null, memory: { ...base.memory, files: 0, indexLines: null }, gate: { ...base.gate, due: false, code: "no-memory" as const, reason: "No files." } },
  ];

  it("shows all projects, those with or without memory, and those the scheduler would dream", async () => {
    renderSlot<PluginNavPanelProps, RpcContract>({ component: DreamPage }, { subPath: "" }, {
      rpc: stubs({ overview: () => ({ ...overview, projects }), history: () => [] }),
    });
    const names = () => ["due-one", "switched-off", "no-memory"].filter((name) => screen.queryByText(name) !== null);
    expect(await screen.findByText("due-one")).toBeTruthy();
    expect(names()).toEqual(["due-one", "switched-off", "no-memory"]);
    fireEvent.click(screen.getByRole("button", { name: "With memory (2)" }));
    expect(names()).toEqual(["due-one", "switched-off"]);
    fireEvent.click(screen.getByRole("button", { name: "Without memory (1)" }));
    expect(names()).toEqual(["no-memory"]);
    fireEvent.click(screen.getByRole("button", { name: "Dream eligible (1)" }));
    expect(names()).toEqual(["due-one"]);
    fireEvent.click(screen.getByRole("button", { name: "All projects (3)" }));
    expect(names()).toEqual(["due-one", "switched-off", "no-memory"]);
  });
});

describe("app boundaries", () => {
  it.each(appFiles)("%s takes the SDK root and the contract as types only", (file) => {
    const source = readFileSync(join(root, file), "utf8");
    expect(source.match(/^import\s+(?!type\b)[^;]*from\s+"@get-bb\/plugin-sdk"/m)).toBeNull();
    expect(source.match(/^import\s+(?!type\b)[^;]*from\s+"[./]*shared\/contract"/m)).toBeNull();
    expect(source).not.toMatch(/from\s+"[./]*(server|host)\//);
  });

  it("names only icons bb draws", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bb: { branding: { icon: string } } };
    const used = new Set([manifest.bb.branding.icon]);
    for (const file of appFiles) {
      for (const match of readFileSync(join(root, file), "utf8").matchAll(/(?:name|icon)[=:]\s*\{?\s*"([A-Za-z]+)"/g)) used.add(match[1]);
      for (const match of readFileSync(join(root, file), "utf8").matchAll(/name=\{[^}]*\?\s*"([A-Za-z]+)"\s*:\s*"([A-Za-z]+)"/g)) {
        used.add(match[1]);
        used.add(match[2]);
      }
    }
    expect(used.size).toBeGreaterThan(5);
    for (const name of used) expect(BB_ICON_NAMES, name).toContain(name);
  });
});
