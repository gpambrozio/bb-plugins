#!/usr/bin/env node
/**
 * Prints the commit a new release tag for `<plugin-id>` belongs on: the one on `HEAD`'s
 * first-parent history that brought its `package.json` to the version it declares now. See
 * `introducingCommit` in `plugins.mjs` for why that commit and not `HEAD`.
 *
 * Run as `node .github/scripts/release-commit.mjs <plugin-id>` from the repository root, in a
 * clone with full history (`fetch-depth: 0`).
 */
import { introducingCommit } from "./plugins.mjs";

const [id] = process.argv.slice(2);
if (id === undefined) {
  console.error("usage: release-commit.mjs <plugin-id>");
  process.exit(2);
}
console.log(introducingCommit(id));
