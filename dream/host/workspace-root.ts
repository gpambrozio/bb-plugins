/**
 * Where dream workspaces live: a user-private cache folder, never inside bb's own data folder.
 *
 * bb refuses a thread workspace inside the storage it manages (bb 0.49, `isBbManagedWorkspacePath`):
 * anything under `<data dir>/plugins/<plugin>/<kind>/` (a plugin's `host-data` among them) or under
 * its legacy `worktrees/` and `personal-workspaces/`, unless the project already has an environment
 * there; the spawn answers "HTTP 409: Workspace path is inside bb-managed storage but is not a
 * workspace of this project". A dream workspace in the plugin's host data folder was refused for that
 * reason. bb compares paths as spelled, so a data folder named through a symlink (macOS's `/var`) hid
 * the rule in testing; `insideBbData` compares real paths.
 */
import { realpathSync } from "node:fs";
import path from "node:path";

export interface WorkspaceRootEnvironment {
  XDG_CACHE_HOME?: string;
  LOCALAPPDATA?: string;
}

/** `<platform cache folder>/bb-dream/workspaces`. */
export function dreamWorkspacesRoot(platform: string, home: string, env: WorkspaceRootEnvironment): string {
  if (platform === "darwin") return path.join(home, "Library", "Caches", "bb-dream", "workspaces");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "bb-dream", "workspaces");
  const xdg = env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : path.join(home, ".cache");
  return path.join(xdg, "bb-dream", "workspaces");
}

/** bb's data folder, from the host data folder bb gives the plugin: `<data dir>/plugins/<id>/host-data`. */
export function bbDataRoot(hostDataDir: string): string {
  return path.resolve(hostDataDir, "..", "..", "..");
}

/** The deepest existing part of `target`, resolved, with the rest appended. */
function real(target: string): string {
  let existing = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(existing), ...rest.reverse());
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(target);
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
}

/** Whether `candidate` is inside bb's data folder, compared by real path. */
export function insideBbData(dataRoot: string, candidate: string): boolean {
  const relative = path.relative(real(dataRoot), real(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
