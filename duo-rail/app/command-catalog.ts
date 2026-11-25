// Every `bb` command the Run a bb command picker can offer: the installed plugins' commands with their
// subcommands, and bb's own.
//
// The SDK's plugin list names each plugin's top-level command and nothing below it, and has no list of
// bb's own commands. bb's command-line tool has both: `bb guide commands` lists bb's own commands (a
// `bb <path> <arguments>` line, then its summary indented; the text, because the `--json` form is three
// times the size and its start was lost from the terminal's buffer before it could be read), and each
// plugin's `bb <name> --help` lists its subcommands under `Commands:`, one
// `bb <name> <sub>  summary` line each (bb renders that from the plugin's registered metadata). So the
// editor runs those once, in one terminal on the server's machine (bb-command.ts), and parses them. When
// that is not possible, the plugins' top-level commands are still offered.
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

import { plainText, runBbScript, type RunOptions } from "./bb-command";

export interface CommandEntry {
  /** The words after `bb`, such as `automation list`. */
  path: string;
  summary: string;
  /** The plugin's command name, or null for one of bb's own. */
  plugin: string | null;
}

export interface CommandCatalog {
  commands: CommandEntry[];
  /** Why only the plugins' top-level commands are listed, or null when the list is complete. */
  problem: string | null;
}

export interface PluginCommand {
  name: string;
  summary: string;
}

const CORE_START = "@@duo-rail:core@@";
const pluginStart = (name: string) => `@@duo-rail:plugin ${name}@@`;

/** `$0` is bb's launcher, `$@` the plugins' command names. Each part is introduced by a marker line. */
export const CATALOG_SCRIPT = [
  `printf '%s\\n' '${CORE_START}'`,
  `"$0" guide commands 2>/dev/null`,
  `for name in "$@"; do printf '\\n@@duo-rail:plugin %s@@\\n' "$name"; "$0" "$name" --help 2>/dev/null; done`,
  // The loop's last `--help` may fail; the catalog does not depend on it.
  "true",
].join("; ");

/** The command words of a usage line: what comes before its first argument or option. */
function pathOf(usage: string): string {
  const words: string[] = [];
  for (const word of usage.trim().split(/\s+/)) {
    if (/^[<[-]/.test(word)) break;
    words.push(word);
  }
  return words.join(" ");
}

/** bb's own commands, from `bb guide commands`: `bb <path> <arguments>`, then the summary indented. */
export function parseCoreCommands(text: string): CommandEntry[] {
  const lines = text.split("\n");
  const entries: CommandEntry[] = [];
  lines.forEach((line, index) => {
    if (!line.startsWith("bb ")) return;
    const path = pathOf(line.slice(3));
    if (path === "") return;
    const next = lines[index + 1] ?? "";
    entries.push({ path, summary: /^\s{2,}\S/.test(next) ? next.trim() : "", plugin: null });
  });
  return entries;
}

/** A plugin's subcommands, from the `Commands:` section of `bb <name> --help`. */
export function parsePluginHelp(name: string, text: string): CommandEntry[] {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trim() === "Commands:");
  if (at < 0) return [];
  const prefix = `bb ${name} `;
  const entries: CommandEntry[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "") {
      if (entries.length > 0) break;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed.startsWith(prefix)) continue;
    // `bb git viewed list    List files marked Viewed`: words, two or more spaces, the summary.
    const match = /^bb (.+?)(?:\s{2,}(.*))?$/.exec(trimmed);
    if (match === null) continue;
    const path = (match[1] ?? "").trim();
    if (path.split(" ").some((word) => /^[<[-]/.test(word))) continue;
    entries.push({ path, summary: (match[2] ?? "").trim(), plugin: name });
  }
  return entries;
}

/** Splits the catalog script's output into bb's own commands and each plugin's subcommands. */
export function parseCatalogOutput(output: string, plugins: readonly PluginCommand[]): { core: CommandEntry[]; subcommands: CommandEntry[] } {
  const text = plainText(output);
  const coreAt = text.indexOf(CORE_START);
  const markers = plugins
    .map((plugin) => ({ plugin, at: text.indexOf(pluginStart(plugin.name)) }))
    .filter((marker) => marker.at >= 0)
    .sort((a, b) => a.at - b.at);
  const coreEnd = markers[0]?.at ?? text.length;
  const core = coreAt < 0 ? [] : parseCoreCommands(text.slice(coreAt + CORE_START.length, coreEnd));
  const subcommands = markers.flatMap((marker, index) => {
    const from = marker.at + pluginStart(marker.plugin.name).length;
    const to = markers[index + 1]?.at ?? text.length;
    return parsePluginHelp(marker.plugin.name, text.slice(from, to));
  });
  return { core, subcommands };
}

/** The plugins' commands (each top-level one, then its subcommands), then bb's own, without repeats. */
export function mergeCatalog(plugins: readonly PluginCommand[], subcommands: readonly CommandEntry[], core: readonly CommandEntry[]): CommandEntry[] {
  const seen = new Set<string>();
  const out: CommandEntry[] = [];
  const add = (entry: CommandEntry) => {
    if (seen.has(entry.path)) return;
    seen.add(entry.path);
    out.push(entry);
  };
  for (const plugin of [...plugins].sort((a, b) => a.name.localeCompare(b.name))) {
    add({ path: plugin.name, summary: plugin.summary, plugin: plugin.name });
    for (const entry of subcommands) if (entry.plugin === plugin.name) add(entry);
  }
  for (const entry of core) add(entry);
  return out;
}

type Sdk = Pick<PluginBrowserBbSdk, "system" | "terminals">;

export async function loadCommandCatalog(sdk: Sdk, plugins: readonly PluginCommand[], options: RunOptions = {}): Promise<CommandCatalog> {
  const topLevel = mergeCatalog(plugins, [], []);
  const names = plugins.map((plugin) => plugin.name);
  let result;
  try {
    result = await runBbScript(sdk, CATALOG_SCRIPT, names, { title: "Duo Rail: list bb commands", ...options });
  } catch (error: unknown) {
    return { commands: topLevel, problem: `bb's commands could not be listed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (result.outcome === "unavailable") return { commands: topLevel, problem: result.reason };
  if (result.outcome === "timed-out") return { commands: topLevel, problem: "Listing bb's commands took over a minute, so only the plugins' commands are listed." };
  if (result.outcome === "cancelled") return { commands: topLevel, problem: "Listing bb's commands was stopped, so only the plugins' commands are listed." };
  const { core, subcommands } = parseCatalogOutput(result.output, plugins);
  return {
    commands: mergeCatalog(plugins, subcommands, core),
    problem: core.length === 0 ? "bb's own commands could not be read, so only the plugins' commands are listed." : null,
  };
}

/** The entries whose words or summary contain every word typed, in catalog order. */
export function filterCatalog(commands: readonly CommandEntry[], query: string): CommandEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...commands];
  return commands.filter((entry) => {
    const haystack = `${entry.path} ${entry.summary}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
