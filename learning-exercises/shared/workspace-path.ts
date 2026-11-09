/**
 * Workspace-relative paths, normalized the way bb's workspace file target takes them. Shared by the app
 * (file links) and the server (orientation listings and export), so both agree on what is inside the
 * workspace. No imports: the app bundle imports it at run time.
 */

/**
 * A path as bb's workspace file target takes it: relative, with no `.` or `..` segments (bb leaves a
 * target with them inert). `./src/a.ts` and `src/../src/a.ts` become `src/a.ts`; null for an absolute or
 * home path, an empty one, and one that climbs out of the workspace.
 */
export function workspacePath(path: string): string | null {
  if (path.startsWith("/") || path.startsWith("~") || path.includes("\\")) return null;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.pop() === undefined) return null;
  }
  return segments.length === 0 ? null : segments.join("/");
}
