/**
 * The first-run guide's folder browser: the folders on one machine, through bb's own host calls — the
 * listing bb's Add project dialog browses with (`hosts.directory`) and `files.mkdir` for a new folder.
 * bb does not export that dialog's browser to plugins, so this is a small one of the same calls.
 *
 * It only chooses a path. The guide's server checks the chosen path exactly as it checks a typed one
 * (`server/intro.ts`): a folder made here is a new, empty folder, which the guide takes as it would a
 * missing one.
 */
import { useSdk } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { Input } from "../components/ui/input";
import { errorText } from "./notify";

/** One folder as the browser shows it: the machine's listing with its files left out. */
export interface FolderListing {
  directory: string;
  parent: string | null;
  folders: { name: string; path: string }[];
}

/** How many folders up from the typed one the browser looks for one that exists. */
const MAX_ANCESTORS = 32;

/** `~` and `~/…` under the machine's home folder; anything else as it is. */
export function expandHome(typed: string, homeFolder: string): string {
  const trimmed = typed.trim();
  if (trimmed === "~") return homeFolder;
  if (trimmed.startsWith("~/")) return joinPath(homeFolder, trimmed.slice(2));
  return trimmed;
}

export function joinPath(folder: string, name: string): string {
  return folder.endsWith("/") ? `${folder}${name}` : `${folder}/${name}`;
}

/** The folder above `path`, or null at the root. */
export function parentOf(path: string): string | null {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const cut = trimmed.lastIndexOf("/");
  if (cut < 0 || trimmed === "/") return null;
  return cut === 0 ? "/" : trimmed.slice(0, cut);
}

/** Why a new folder's name will not do, or null when it will: one plain name, inside the folder shown. */
export function folderNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Type a name for the new folder.";
  if (trimmed === "." || trimmed === "..") return "Use a name, not . or ..";
  if (trimmed.includes("/") || trimmed.includes("\0")) return "Use a name without a /.";
  return null;
}

function useFolderLister(hostId: string) {
  const sdk = useSdk();
  return async (path?: string): Promise<FolderListing> => {
    const listing = await sdk.hosts.directory({ hostId, ...(path === undefined ? {} : { path }) });
    return {
      directory: listing.directory,
      parent: listing.parent,
      folders: listing.entries.filter((entry) => entry.kind === "directory").map(({ name, path: at }) => ({ name, path: at })),
    };
  };
}

/**
 * Lists the folder the typed path names, or the nearest folder above it that exists — so a home that is
 * still to be created opens where it would be created — and the machine's home folder when nothing does.
 */
export async function openNearest(list: (path?: string) => Promise<FolderListing>, typed: string): Promise<FolderListing> {
  const home = await list();
  let candidate: string | null = expandHome(typed, home.directory);
  if (!candidate.startsWith("/")) return home;
  for (let step = 0; candidate !== null && step < MAX_ANCESTORS; step += 1) {
    if (candidate === home.directory) return home;
    try {
      return await list(candidate);
    } catch {
      candidate = parentOf(candidate);
    }
  }
  return home;
}

export function FolderBrowser({
  hostId,
  machine,
  typed,
  onPick,
  onClose,
}: {
  hostId: string;
  /** The machine's name, for the heading. */
  machine: string | null;
  /** The path in the Home folder field when the browser opened. */
  typed: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const sdk = useSdk();
  const list = useFolderLister(hostId);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  // Only the newest request may show its answer: a slow listing must not replace a later one.
  const request = useRef(0);

  function show(load: () => Promise<FolderListing>): Promise<boolean> {
    const mine = ++request.current;
    setLoading(true);
    setError(null);
    return load().then(
      (next) => {
        if (mine !== request.current) return false;
        setListing(next);
        setLoading(false);
        return true;
      },
      (caught: unknown) => {
        if (mine !== request.current) return false;
        setError(errorText(caught));
        setLoading(false);
        return false;
      },
    );
  }

  useEffect(() => {
    // Opened once, at the typed path; afterwards the browser goes where the captain clicks.
    void show(() => openNearest(list, typed));
  }, [hostId]);

  function open(path: string): void {
    setNaming(false);
    void show(() => list(path));
  }

  function create(): void {
    if (listing === null) return;
    const problem = folderNameProblem(name);
    if (problem !== null) {
      setError(problem);
      return;
    }
    const path = joinPath(listing.directory, name.trim());
    setCreating(true);
    setError(null);
    sdk.files
      .mkdir({ hostId, path, recursive: false })
      .then(async () => {
        setNaming(false);
        setName("");
        await show(() => list(path));
      })
      .catch((caught: unknown) => setError(errorText(caught)))
      .finally(() => setCreating(false));
  }

  const current = listing?.directory ?? null;

  return (
    <div role="group" aria-label="Folder browser" className="flex flex-col gap-2 rounded-md border border-border bg-card p-2 text-card-foreground">
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Up one folder"
          disabled={loading || listing?.parent == null}
          onClick={() => listing?.parent != null && open(listing.parent)}
        >
          <Icon name="ArrowUp" fallback="ChevronUp" className="size-4" />
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={current ?? undefined}>
          {current ?? (machine === null ? "Loading…" : `Loading ${machine}…`)}
        </span>
        <Button type="button" variant="ghost" size="sm" disabled={listing === null || creating} onClick={() => setNaming(true)}>
          <Icon name="FolderPlus" fallback="Plus" className="size-4" />
          New folder
        </Button>
      </div>
      {naming ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <Input
            aria-label="New folder name"
            value={name}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder="FirstMate"
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={creating}>
            {creating ? "Creating…" : "Create"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setNaming(false);
              setName("");
              setError(null);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : null}
      <ul aria-label="Folders" className="flex max-h-48 min-h-24 flex-col overflow-y-auto">
        {listing !== null && listing.folders.length === 0 && !loading ? (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">No folders here.</li>
        ) : null}
        {(listing?.folders ?? []).map((folder) => (
          <li key={folder.path}>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-state-hover disabled:opacity-50"
              disabled={loading}
              onClick={() => open(folder.path)}
            >
              <Icon name="Folder" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{folder.name}</span>
              <Icon name="ChevronRight" className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button type="button" size="sm" disabled={current === null || loading} onClick={() => current !== null && onPick(current)}>
          Use this folder
        </Button>
      </div>
    </div>
  );
}
