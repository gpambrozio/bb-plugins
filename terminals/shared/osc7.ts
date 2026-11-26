/**
 * The directory a shell reports with OSC 7. No SDK import, so the app may use it.
 */

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
