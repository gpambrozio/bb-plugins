/**
 * A skill's body renders through bb's own `Markdown`, which loads an image as
 * soon as it draws it and takes no say over that. A skill someone else wrote
 * can carry a remote image — a tracking pixel among them — and opening its
 * detail should fetch nothing. So every image becomes a link to its source,
 * which loads only if followed. Fenced code is left as written.
 */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
// `![alt](src)` and `![alt][ref]`; the `!` goes, the link stays.
const IMAGE = /!(\[[^\]\n]*\](?:\(|\[))/g;

export function withoutImages(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (marker !== undefined) {
        if (fence === null) fence = marker[0]!;
        else if (marker[0] === fence) fence = null;
        return line;
      }
      return fence === null ? line.replace(IMAGE, "$1") : line;
    })
    .join("\n");
}
