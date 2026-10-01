/**
 * The custom command is one line of text the user typed, and the prompt is a
 * template they may have edited. Both are turned into what a process needs
 * here, with no shell in between: the command is split into words the way a
 * shell would read quotes, then spawned as is, so nothing in a prompt or a
 * value is ever interpreted.
 */

/**
 * Shell-style word splitting: whitespace separates words, single and double
 * quotes keep theirs, a backslash escapes the next character outside single
 * quotes, and `""` is an empty word (Claude Code's `--tools ""`).
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] as string;
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (char === "\\" && i + 1 < line.length) {
      current += line[i + 1];
      inWord = true;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
      continue;
    }
    current += char;
    inWord = true;
  }
  if (quote !== null) throw new Error("The command has an unterminated quote.");
  if (inWord) words.push(current);
  if (words.length === 0) throw new Error("The command is empty.");
  return words;
}

/**
 * `{{name}}` placeholders, matched without regard to case, each replaced in
 * one pass so a value holding a placeholder is left as it is. A null value,
 * or a key the template names that is not given, reads "none".
 */
export function fillTemplate(template: string, values: Record<string, string | null | undefined>): string {
  const byKey = new Map<string, string | null | undefined>();
  for (const [key, value] of Object.entries(values)) byKey.set(key.toLowerCase(), value);
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, name: string) => {
    const key = name.toLowerCase();
    if (!byKey.has(key)) return whole;
    const value = byKey.get(key);
    return value === null || value === undefined || value.trim() === "" ? "none" : value;
  });
}
