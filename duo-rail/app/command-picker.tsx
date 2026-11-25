// The Run a bb command field: a text box for the words after `bb`, with a list of every command on offer
// below it, narrowed as the owner types. A `<datalist>` would not do: browsers show only the entries
// that match the text already in the box, so a box that holds a command lists that one command.
import { useSdk } from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useMemo, useState } from "react";

import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import { joinArgs, splitArgs } from "../shared/layout";
import { filterCatalog, loadCommandCatalog, mergeCatalog, type CommandCatalog, type PluginCommand } from "./command-catalog";

/** One listing per page and set of plugins: it runs bb a few dozen times, so every field shares it. */
const catalogs = new Map<string, Promise<CommandCatalog>>();

export function resetCommandCatalogCache(): void {
  catalogs.clear();
}

/** The full command list, or null while it loads. Waits for the plugins' list (null) before loading. */
function useCommandCatalog(plugins: readonly PluginCommand[] | null): CommandCatalog | null {
  const sdk = useSdk();
  const key = plugins === null ? null : plugins.map((plugin) => plugin.name).sort().join(" ");
  const [loaded, setLoaded] = useState<{ key: string; catalog: CommandCatalog } | null>(null);
  useEffect(() => {
    if (key === null || plugins === null) return;
    let live = true;
    let pending = catalogs.get(key);
    if (pending === undefined) {
      pending = loadCommandCatalog(sdk, plugins);
      catalogs.set(key, pending);
    }
    void pending.then((catalog) => {
      if (live) setLoaded({ key, catalog });
    });
    return () => {
      live = false;
    };
    // `plugins` is read only when `key` changes, and `key` names the same plugins.
  }, [key, sdk]);
  return loaded !== null && loaded.key === key ? loaded.catalog : null;
}

const sameWords = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((word, index) => word === b[index]);

export function CommandPicker({
  id,
  args,
  plugins,
  onChange,
}: {
  id: string;
  args: readonly string[];
  /** The installed plugins' commands, or null while they load. */
  plugins: readonly PluginCommand[] | null;
  onChange(args: string[]): void;
}) {
  // The text as typed, so quotes and spaces stay while the owner types; the words are what is saved.
  const [text, setText] = useState(() => joinArgs(args));
  // When the words no longer match, the command was replaced from outside (Discard, Import, the other
  // display's button with the same id): show the new one. What this box sends always splits back to the
  // same words, so typing is left alone. (Compared with the command's own text too, so a command whose text
  // does not split back exactly cannot set it again on every render.)
  if (!sameWords(splitArgs(text), args) && text !== joinArgs(args)) setText(joinArgs(args));
  // What narrows the list: empty when the box gains focus, so every command shows; then what is typed.
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const catalog = useCommandCatalog(plugins);
  const commands = useMemo(() => catalog?.commands ?? mergeCatalog(plugins ?? [], [], []), [catalog, plugins]);
  const matches = useMemo(() => filterCatalog(commands, query), [commands, query]);
  const listId = useId();
  const optionId = (index: number) => `${listId}-${index}`;

  const choose = (path: string) => {
    setText(path);
    setQuery(path);
    setOpen(false);
    onChange(splitArgs(path));
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm text-muted-foreground">bb</span>
        <Input
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && matches.length > 0 ? optionId(Math.min(active, matches.length - 1)) : undefined}
          className="font-mono"
          placeholder="Pick a command or type one"
          value={text}
          onFocus={() => {
            setQuery("");
            setActive(0);
            setOpen(true);
          }}
          onBlur={() => setOpen(false)}
          onChange={(event) => {
            setText(event.target.value);
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
            onChange(splitArgs(event.target.value));
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((index) => Math.max(0, Math.min(matches.length - 1, index + step)));
              return;
            }
            const picked = matches[Math.min(active, matches.length - 1)];
            if (event.key === "Enter" && open && picked !== undefined) {
              event.preventDefault();
              choose(picked.path);
            }
          }}
        />
      </div>
      {open && (
        <ul id={listId} role="listbox" aria-label="bb commands" className="max-h-64 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground">
          {matches.map((entry, index) => (
            <li
              key={entry.path}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              className={cn("flex cursor-pointer flex-col rounded-sm px-2 py-1.5", index === active ? "bg-state-active" : "hover:bg-state-hover")}
              // Keep focus in the box, so choosing does not close the list before the click lands.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(entry.path)}
            >
              <span className="font-mono text-sm">bb {entry.path}</span>
              {entry.summary !== "" && <span className="text-xs text-muted-foreground">{entry.summary}</span>}
            </li>
          ))}
          {matches.length === 0 && catalog !== null && <li className="px-2 py-1.5 text-xs text-muted-foreground">No command matches. bb runs what you type as it is.</li>}
          {catalog === null && <li className="px-2 py-1.5 text-xs text-muted-foreground">Listing bb's own commands and the plugins' subcommands…</li>}
        </ul>
      )}
      {catalog?.problem != null && <span className="text-xs text-muted-foreground">{catalog.problem}</span>}
    </div>
  );
}
