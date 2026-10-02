#!/usr/bin/env node
/**
 * Prints the plugins from `.bb/plugins.json` as a JSON array, for a workflow matrix.
 *
 * With `--unreleased`, only those `release.yml` has work for: the declared version has no
 * `<id>/vX.Y.Z` tag, or has one but no GitHub release (a run that pushed the tag and then failed,
 * or a tag cut by hand). Keyed on what exists rather than on what the push changed, which buys
 * three things: a bump that merged while the release workflow was broken is picked up by the next
 * push to land, "Re-run all jobs" on a half-finished run finishes it, and running the same commit
 * twice does nothing twice. Needs the clone's tags (`fetch-depth: 0`) and `gh` with a token
 * (`GH_TOKEN`, `GH_REPO`) to look the releases up.
 *
 * Run as `node .github/scripts/list-plugins.mjs [--unreleased]` from the repository root. What it
 * chose and why goes to stderr; stdout is only the array.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginsToRelease, readPluginIds } from "./plugins.mjs";

function versionOf(id) {
  return JSON.parse(readFileSync(join(id, "package.json"), "utf8")).version;
}

function tagExists(tag) {
  return execFileSync("git", ["tag", "--list", tag], { encoding: "utf8" }).trim() !== "";
}

/** Whether GitHub has a release for `tag`. Any failure other than "not found" is fatal. */
function releaseExists(tag) {
  try {
    execFileSync("gh", ["release", "view", tag, "--json", "tagName"], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
    return true;
  } catch (error) {
    if (/release not found/i.test(error.stderr ?? "")) return false;
    throw error;
  }
}

const ids = readPluginIds();
if (!process.argv.includes("--unreleased")) {
  console.log(JSON.stringify(ids));
} else {
  const chosen = pluginsToRelease(ids, { versionOf, tagExists, releaseExists });
  for (const { tag, reason } of chosen) console.error(`${tag}: ${reason}; releasing it.`);
  if (chosen.length === 0) console.error("Every plugin's version is tagged and released.");
  console.log(JSON.stringify(chosen.map(({ id }) => id)));
}
