/**
 * The app bundle must not import the SDK root at run time, directly or through
 * a shared module: bb provides `@get-bb/plugin-sdk` to the server bundle only,
 * and a git install (production dependencies only) has no copy to bundle — the
 * build fails there and nowhere else. So the app and the shared module it
 * imports take the SDK root, the server entry and both contracts as types.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const files = [
  "app.tsx",
  "shared/skills.ts",
  ...readdirSync(join(root, "app"))
    .filter((name) => /\.tsx?$/.test(name) && !name.includes(".test."))
    .map((name) => join("app", name)),
];

describe("app imports", () => {
  it.each(files)("%s takes the SDK root, the server and the contracts as types only", (file) => {
    const source = readFileSync(join(root, file), "utf8");
    expect(source.match(/^import\s+(?!type\b)[^;]*from\s+"@get-bb\/plugin-sdk"/m)).toBeNull();
    expect(source.match(/^import\s+(?!type\b)[^;]*from\s+"[./]*(?:server|shared\/contract|shared\/host-contract)"/m)).toBeNull();
  });
});
