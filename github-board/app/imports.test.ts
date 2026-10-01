/**
 * The app bundle must not import `shared/contract.ts` at run time: that file
 * imports `defineRpcContract` from the SDK root, which bb provides to the
 * server bundle only, and a git install (production dependencies only) has no
 * copy to bundle — the build fails there and nowhere else.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const appFiles = [
  "app.tsx",
  ...readdirSync(join(root, "app"))
    .filter((name) => /\.tsx?$/.test(name) && !name.includes(".test."))
    .map((name) => join("app", name)),
];

describe("app imports", () => {
  it.each(appFiles)("%s imports the contract as a type only", (file) => {
    const source = readFileSync(join(root, file), "utf8");
    const runtime = source.match(/^import\s+(?!type\b)[^;]*from\s+"[./]*shared\/contract"/m);
    expect(runtime).toBeNull();
  });
});
