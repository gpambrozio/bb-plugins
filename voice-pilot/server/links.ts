/**
 * What `open_link` may open: a web page (http or https, no user name or password in it) or a bb thread
 * (a `@thread:` mention, kept as `bb:thread/<id>`). A bb link on the web (the bb app's own address) is a web
 * URL here; the window that holds the call sees it is its own address and shows it with bb's navigation.
 */

export type LinkTarget = { kind: "web"; url: string; label: string } | { kind: "thread"; threadId: string };

/** The longest URL opened. */
export const URL_MAX = 2_048;

/** A URL as the card shows it: host and path, no scheme or `www.`, cut short. */
export function linkLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const shown = `${parsed.host.replace(/^www\./u, "")}${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
    return shown.length > 80 ? `${shown.slice(0, 79)}…` : shown;
  } catch {
    return url.slice(0, 80);
  }
}

/** The target a link names, or why it cannot be opened. */
export function linkTarget(raw: string): LinkTarget | { error: string } {
  const text = raw.trim();
  const thread = /^(?:bb:thread\/|@thread:)(thr_[A-Za-z0-9]+)(?:#msg=\d+)?$/u.exec(text);
  if (thread !== null) return { kind: "thread", threadId: thread[1] as string };
  if (text.length > URL_MAX) return { error: "That link is too long to open." };
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { error: "That is not a link." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { error: "Only web links (http or https) and bb's own links can be opened." };
  if (parsed.username !== "" || parsed.password !== "") return { error: "A link with a user name or password in it is not opened." };
  return { kind: "web", url: parsed.href, label: linkLabel(parsed.href) };
}
