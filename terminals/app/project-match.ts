/**
 * Which project a new thread for a terminal's selection starts in: the one
 * whose checkout (or a thread's worktree) holds the shell's working directory
 * on that machine, else the one the user picked last time, else the project
 * of their most recent thread. No React and no SDK.
 */

/** A directory bb knows belongs to a project on one machine. */
export interface ProjectPlace {
  projectId: string;
  hostId: string;
  path: string;
}

/**
 * The directory an OSC 7 sequence reports (`file://host/path`, which shells
 * send as they change directory), or null for anything else. The host part
 * is not checked: it names the machine as the shell sees it, which need not
 * match bb's name for it, and the tab already says which machine it is.
 */
export function directoryFromOsc7(data: string): string | null {
  let url: URL;
  try {
    url = new URL(data.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // file:///C:/Users/... on Windows.
  path = path.replace(/^\/([A-Za-z]:\/)/, "$1");
  return path === "" ? null : path;
}

const WINDOWS_DRIVE = /^[A-Za-z]:([\\/]|$)/;

/**
 * `path` in one spelling to compare by: a Windows path (`C:\Users\me`, or
 * `C:/Users/me` as OSC 7 gives it) with forward slashes and lower case, as
 * Windows ignores case; a POSIX path as it is. No trailing slash, except for
 * a root (`/`, `c:/`).
 */
export function comparablePath(path: string): string {
  if (WINDOWS_DRIVE.test(path)) {
    const forward = path.replace(/\\/g, "/").toLowerCase();
    const trimmed = forward.replace(/\/+$/, "");
    return /^[a-z]:$/.test(trimmed) ? `${trimmed}/` : trimmed;
  }
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** Whether `inner` is `root` or inside it, both already `comparablePath`s. */
function contains(root: string, inner: string): boolean {
  return inner === root || inner.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * The project of the deepest known directory holding `cwd` on `hostId`, so a
 * worktree inside a checkout wins over the checkout. Null when none does, or
 * when the shell has not said where it is.
 */
export function projectForDirectory(cwd: string | null, hostId: string, places: readonly ProjectPlace[]): string | null {
  if (cwd === null) return null;
  const inner = comparablePath(cwd);
  let best: { projectId: string; root: string } | null = null;
  for (const place of places) {
    if (place.hostId !== hostId || place.path === "") continue;
    const root = comparablePath(place.path);
    if (!contains(root, inner)) continue;
    if (best === null || root.length > best.root.length) best = { projectId: place.projectId, root };
  }
  return best?.projectId ?? null;
}

/**
 * The project the "New thread" choice starts on: the terminal's, else the
 * last one picked, else the most recent thread's, else the first. Only
 * projects in `available` count.
 */
export function defaultProject(options: {
  available: readonly string[];
  fromDirectory: string | null;
  lastUsed: string | null;
  mostRecentThread: string | null;
}): string | null {
  const { available, fromDirectory, lastUsed, mostRecentThread } = options;
  for (const candidate of [fromDirectory, lastUsed, mostRecentThread]) {
    if (candidate !== null && available.includes(candidate)) return candidate;
  }
  return available[0] ?? null;
}

const LAST_PROJECT_KEY = "bb-plugin-terminals:last-new-thread-project";

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The project the user last started a thread in from here, in this browser. */
export const lastProject = {
  get(): string | null {
    try {
      return browserStorage()?.getItem(LAST_PROJECT_KEY) ?? null;
    } catch {
      return null;
    }
  },
  set(projectId: string): void {
    try {
      browserStorage()?.setItem(LAST_PROJECT_KEY, projectId);
    } catch {
      // Private browsing or a full quota: the default falls back to the most recent thread.
    }
  },
};
