/**
 * The app bundle must not import `shared/contract.ts` (the SDK root, which bb gives the server
 * bundle only) or `shared/actions-file.ts` (the parser) at run time. A git install builds with
 * production dependencies only, so the contract import fails there and nowhere else.
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
  it.each(appFiles)("%s imports the contract as a type only, and not the parser", (file) => {
    const source = readFileSync(join(root, file), "utf8");
    expect(source.match(/^import\s+(?!type\b)[^;]*from\s+"[./]*shared\/contract"/m)).toBeNull();
    expect(source).not.toMatch(/shared\/actions-file"/);
  });
});
