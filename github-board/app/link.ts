/**
 * Whether a link out of a body or a comment is one the board hands to the
 * opener: http and https, and nothing else. A comment's author picks the
 * scheme, and a `javascript:`, `file:` or custom-app link has no business
 * leaving the panel. The plugin says so itself rather than relying on the
 * host's opener to refuse them.
 */
export function isOpenableLink(url: string): boolean {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return false;
  }
  return protocol === "https:" || protocol === "http:";
}
