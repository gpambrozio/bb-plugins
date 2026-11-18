/**
 * A line diff for the proposal view: longest common subsequence over lines, then runs of unchanged
 * lines folded to `context` lines on each side of a change. Memory files are small; past
 * `MAX_CELLS` the whole old text is shown removed and the new one added rather than compared. No SDK
 * import, so the app uses it at run time.
 */
export type DiffRow =
  | { kind: "same" | "add" | "del"; text: string; oldLine: number | null; newLine: number | null }
  | { kind: "skip"; count: number };

export const MAX_CELLS = 4_000_000;

function lines(text: string | null): string[] {
  if (text === null || text === "") return [];
  const split = text.split("\n");
  if (split[split.length - 1] === "") split.pop();
  return split;
}

type Op = { kind: "same" | "add" | "del"; text: string };

function compare(a: string[], b: string[]): Op[] {
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  }
  // lengths[i][j]: the longest common subsequence of a[i..] and b[j..].
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) ops.push({ kind: "del", text: a[i++] });
    else ops.push({ kind: "add", text: b[j++] });
  }
  while (i < a.length) ops.push({ kind: "del", text: a[i++] });
  while (j < b.length) ops.push({ kind: "add", text: b[j++] });
  return ops;
}

/** The rows to show for `before` → `after` (null for a file that does not exist on that side). */
export function lineDiff(before: string | null, after: string | null, context = 3): DiffRow[] {
  const ops = compare(lines(before), lines(after));
  const numbered: Array<Extract<DiffRow, { text: string }>> = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    numbered.push({ ...op, oldLine: op.kind === "add" ? null : oldLine, newLine: op.kind === "del" ? null : newLine });
    if (op.kind !== "add") oldLine++;
    if (op.kind !== "del") newLine++;
  }
  const near = numbered.map(() => false);
  numbered.forEach((row, index) => {
    if (row.kind === "same") return;
    for (let k = Math.max(0, index - context); k <= Math.min(numbered.length - 1, index + context); k++) near[k] = true;
  });
  const rows: DiffRow[] = [];
  let skipped = 0;
  numbered.forEach((row, index) => {
    if (near[index]) {
      if (skipped > 0) rows.push({ kind: "skip", count: skipped });
      skipped = 0;
      rows.push(row);
    } else skipped++;
  });
  if (skipped > 0) rows.push({ kind: "skip", count: skipped });
  return rows;
}
