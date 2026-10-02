#!/usr/bin/env node
/**
 * Prints the plugins from `.bb/plugins.json` as a JSON array, for a workflow matrix.
 *
 * With `--untagged`, only those whose declared version has no `<id>/vX.Y.Z` tag in the local
 * clone — what `release.yml` releases on a push to `main`. Keyed on the tag rather than on what
 * the push changed, which buys two things: a bump that merged while the release workflow was
 * broken is still picked up by the next push to land, and running the same commit twice does
 * nothing twice. The clone needs its tags (`fetch-depth: 0`).
 *
 * Run as `node .github/scripts/list-plugins.mjs [--untagged]` from the repository root. What it
 * chose and why goes to stderr; stdout is only the array.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readPluginIds, releaseTag } from "./plugins.mjs";

function isTagged(id) {
  const { version } = JSON.parse(readFileSync(join(id, "package.json"), "utf8"));
  const tag = releaseTag(id, version);
  const tagged = execFileSync("git", ["tag", "--list", tag], { encoding: "utf8" }).trim() !== "";
  console.error(tagged ? `${tag} exists; nothing to release.` : `${tag} does not exist; releasing it.`);
  return tagged;
}

const untaggedOnly = process.argv.includes("--untagged");
const ids = readPluginIds().filter((id) => !untaggedOnly || !isTagged(id));
console.log(JSON.stringify(ids));
