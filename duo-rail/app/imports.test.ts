/**
 * The app bundle must not import the SDK root at run time: bb provides it to the server bundle only,
 * so the import builds from a dev install and fails the production-only build a git install runs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const appFiles = [
  "app.tsx",
  ...["app", "shared", "components", "lib"].flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
      .filter((name) => /\.tsx?$/.test(name) && !name.includes(".test."))
      .map((name) => join(dir, name)),
  ),
];

describe("app imports", () => {
  it.each(appFiles)("%s does not import the SDK root at run time", (file) => {
    const source = readFileSync(join(root, file), "utf8");
    expect(source.match(/^import\s+(?!type\b)[^;]*from\s+"@get-bb\/plugin-sdk"/m)).toBeNull();
  });
});
