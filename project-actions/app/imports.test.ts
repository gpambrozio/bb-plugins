/**
 * The app bundle must not import `shared/contract.ts` at run time: it imports the SDK root, which bb
 * gives the server bundle only. A git install builds with production dependencies only, so the
 * import fails there and nowhere else. (The parser, `shared/actions-file.ts`, is fine: the editor
 * checks a draft with it.)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const appFiles = [
  "app.tsx",
  ...readdirSync(join(root, "app"), { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name) && !name.includes(".test.") && !name.endsWith(".d.ts"))
    .map((name) => join("app", name)),
];

describe("app imports", () => {
  it.each(appFiles)("%s imports the contract as a type only", (file) => {
    const source = readFileSync(join(root, file), "utf8");
    expect(source.match(/^import\s+(?!type\b)[^;]*from\s+"[./]*shared\/contract"/m)).toBeNull();
  });
});
