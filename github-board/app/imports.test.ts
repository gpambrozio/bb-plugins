/**
 * The app bundle must not import `shared/contract.ts` at run time: that file
 * imports `defineRpcContract` from the SDK root, which bb provides to the
 * server bundle only and shims for no app bundle. Before the SDK became a
 * production dependency (for the server's `@get-bb/plugin-sdk/process`), a git
 * install had no copy to bundle and the build failed there and nowhere else;
 * now it would quietly bundle server-side SDK code into the app.
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
