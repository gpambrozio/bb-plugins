/**
 * A link to this bb's own thread: on this window's own address (the bb web app, or bb Connect's address on
 * the phone), with a thread id in its path. Such a link is shown with bb's navigation, in this window,
 * rather than in a new tab.
 */
export function bbThreadLink(url: string, origin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== origin) return null;
  const match = /(?:^|\/)(thr_[A-Za-z0-9]+)(?:\/|$)/u.exec(parsed.pathname);
  return match === null ? null : (match[1] as string);
}
