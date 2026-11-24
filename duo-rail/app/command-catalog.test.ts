import { describe, expect, it } from "vitest";

import { EXIT_MARKER } from "./bb-command";
import { CATALOG_SCRIPT, filterCatalog, loadCommandCatalog, mergeCatalog, parseCatalogOutput, parseCoreCommands, parsePluginHelp } from "./command-catalog";

/** `bb git --help` as bb 0.50.1 prints it. */
const GIT_HELP = `bb git — Read an environment's git status, changed files and diffs

Usage:
  bb git <command> [options]

Commands:
  bb git status         Show an environment's workspace status
  bb git viewed list    List files marked Viewed
  bb git viewed mark    Mark a changed file Viewed at its current revision

Run \`bb git <command> --help\` for a command's arguments and options.
`;

/** `bb guide commands` as bb 0.50.1 prints it. */
const CORE_TEXT = [
  "bb thread list",
  "    List threads",
  "bb plugin reload [id]",
  "    Reload plugins",
  "bb browser acquire <tabIds...>",
  "    Acquire exclusive, expiring control of selected tabs",
  "",
  "Run `bb guide commands <group>` (for example `bb guide commands thread`) to include every option.",
].join("\n");

const PLUGINS = [
  { name: "git", summary: "Read an environment's git status" },
  { name: "agent-graph", summary: "Show a live graph of agents" },
];

/** What the catalog script prints, through a terminal: CRLF line ends. */
const OUTPUT = [
  "@@duo-rail:core@@",
  CORE_TEXT,
  "",
  "@@duo-rail:plugin agent-graph@@",
  "bb agent-graph — Show a live graph",
  "",
  "Commands:",
  "  bb agent-graph show  Print the agent graph (default)",
  "",
  "@@duo-rail:plugin git@@",
  GIT_HELP,
].join("\r\n");

describe("parsing", () => {
  it("reads bb's own commands from `bb guide commands`, their arguments left out", () => {
    expect(parseCoreCommands(CORE_TEXT)).toEqual([
      { path: "thread list", summary: "List threads", plugin: null },
      { path: "plugin reload", summary: "Reload plugins", plugin: null },
      { path: "browser acquire", summary: "Acquire exclusive, expiring control of selected tabs", plugin: null },
    ]);
    expect(parseCoreCommands("Usage: something else")).toEqual([]);
  });

  it("reads a plugin's subcommands, nested ones included, from its help's Commands section only", () => {
    expect(parsePluginHelp("git", GIT_HELP)).toEqual([
      { path: "git status", summary: "Show an environment's workspace status", plugin: "git" },
      { path: "git viewed list", summary: "List files marked Viewed", plugin: "git" },
      { path: "git viewed mark", summary: "Mark a changed file Viewed at its current revision", plugin: "git" },
    ]);
    expect(parsePluginHelp("git", "bb git — no commands here\n")).toEqual([]);
  });

  it("splits the script's output by plugin", () => {
    const { core, subcommands } = parseCatalogOutput(OUTPUT, PLUGINS);
    expect(core.map((entry) => entry.path)).toEqual(["thread list", "plugin reload", "browser acquire"]);
    expect(subcommands.map((entry) => entry.path)).toEqual(["agent-graph show", "git status", "git viewed list", "git viewed mark"]);
  });
});

describe("mergeCatalog", () => {
  it("lists each plugin's command then its subcommands, plugins by name, then bb's own, without repeats", () => {
    const { core, subcommands } = parseCatalogOutput(OUTPUT, PLUGINS);
    expect(mergeCatalog(PLUGINS, [...subcommands, subcommands[0]!], core).map((entry) => entry.path)).toEqual([
      "agent-graph",
      "agent-graph show",
      "git",
      "git status",
      "git viewed list",
      "git viewed mark",
      "thread list",
      "plugin reload",
      "browser acquire",
    ]);
  });
});

describe("filterCatalog", () => {
  const all = mergeCatalog(PLUGINS, parseCatalogOutput(OUTPUT, PLUGINS).subcommands, parseCatalogOutput(OUTPUT, PLUGINS).core);

  it("lists everything for an empty query", () => {
    expect(filterCatalog(all, "  ")).toHaveLength(all.length);
  });

  it("narrows by every typed word, in the command or its summary", () => {
    expect(filterCatalog(all, "viewed").map((entry) => entry.path)).toEqual(["git viewed list", "git viewed mark"]);
    expect(filterCatalog(all, "git revision").map((entry) => entry.path)).toEqual(["git viewed mark"]);
    expect(filterCatalog(all, "THREADS").map((entry) => entry.path)).toEqual(["thread list"]);
  });
});

describe("loadCommandCatalog", () => {
  function sdk(output: string | null) {
    const created: unknown[] = [];
    return {
      created,
      sdk: {
        system: {
          experimental_cliCommand: async () => ({ installedPath: output === null ? null : "/home/me/.local/bin/bb", supported: true, onPath: true, shadowedBy: null }),
          config: async () => ({ primaryHostId: "host1" }),
        },
        terminals: {
          create: async (args: unknown) => {
            created.push(args);
            return { id: "term1" };
          },
          output: async () => ({ chunks: [{ seq: 1, dataBase64: Buffer.from(`${output}${EXIT_MARKER}0\u0007`).toString("base64") }], nextSeq: 2, status: "running", exitCode: null, closeReason: null, truncated: false }),
          close: async () => ({}),
        },
      } as never,
    };
  }

  it("runs one script with the plugins' names and lists every command", async () => {
    const { sdk: fake, created } = sdk(OUTPUT);
    const catalog = await loadCommandCatalog(fake, PLUGINS, { sleep: async () => {} });
    expect(catalog.problem).toBeNull();
    expect(catalog.commands).toHaveLength(9);
    expect(created).toEqual([expect.objectContaining({ start: { mode: "argv", argv: ["/bin/sh", "-c", expect.stringContaining(CATALOG_SCRIPT), "/home/me/.local/bin/bb", "git", "agent-graph"] } })]);
  });

  it("still lists the plugins' commands without bb's command-line tool, and says why", async () => {
    const catalog = await loadCommandCatalog(sdk(null).sdk, PLUGINS, { sleep: async () => {} });
    expect(catalog.commands.map((entry) => entry.path)).toEqual(["agent-graph", "git"]);
    expect(catalog.problem).toMatch(/not installed/);
  });
});
