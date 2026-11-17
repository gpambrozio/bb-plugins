/**
 * How Claude Code names a working directory's folder under `<config>/projects/`, as in Claude Code
 * 2.1.326 (the `nH` function in its bundle): every character that is not an ASCII letter or digit
 * becomes `-`, and a name longer than 200 characters is cut at 200 and given `-<hash>`, the
 * absolute value of a 32-bit Java-style string hash of the original path, in base 36.
 *
 * `CLAUDE_CODE_PROJECT_DIR_NAME` replaces the name for the one process that sets it; it says
 * nothing about other projects, so it is not modelled here.
 */
export const MAX_SLUG_LENGTH = 200;

/** Claude Code's `$Q`: `h = (h << 5) - h + charCode`, kept to 32 bits, over UTF-16 code units. */
export function pathHash(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index++) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  return hash;
}

export function projectSlug(path: string): string {
  const slug = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length <= MAX_SLUG_LENGTH) return slug;
  return `${slug.slice(0, MAX_SLUG_LENGTH)}-${Math.abs(pathHash(path)).toString(36)}`;
}
