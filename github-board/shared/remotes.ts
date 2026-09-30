/**
 * Any git remote URL in the `<host>/<owner>/<name>` form that `repositoryIdFor`
 * gives a card, so a checkout's remotes and a card compare by equality.
 *
 * Covers the scp-like `git@host:owner/name.git` that `new URL` cannot parse
 * alongside the `https://` and `ssh://` spellings. Null for anything that names
 * no repository.
 */
export function normalizeRemoteUrl(remote: string): string | null {
  const trimmed = remote.trim();
  if (trimmed === "") return null;

  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      host = parsed.host;
      path = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(trimmed);
    if (scp === null || scp[1] === undefined || scp[2] === undefined) return null;
    host = scp[1];
    path = scp[2];
  }

  const name = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (host === "" || name === "") return null;
  return `${host}/${name}`.toLowerCase();
}

/**
 * Every repository id in `git remote -v` output, not just `origin`'s. A fork
 * conventionally keeps the repository it was forked from as `upstream`, and a
 * card always names the repository the work lives in — the parent — so
 * `origin` alone cannot match work done from a fork.
 */
export function remoteIdsOf(remoteVerbose: string): string[] {
  const seen = new Set<string>();
  for (const line of remoteVerbose.split("\n")) {
    const url = line.trim().split(/\s+/)[1];
    if (url === undefined) continue;
    const normalized = normalizeRemoteUrl(url);
    if (normalized !== null) seen.add(normalized);
  }
  return [...seen];
}
