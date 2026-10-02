#!/usr/bin/env node
/**
 * Fails a pull request whose version change would not release, or whose changelog change would
 * never be released.
 *
 * Merging a version bump is what releases a plugin here: `release.yml` looks for a plugin whose
 * version has no `<id>/vX.Y.Z` tag, and tags and releases it. Two mistakes slip past that quietly:
 *
 * - **A changelog entry without a version bump.** It merges, `release.yml` sees no new version, and
 *   nobody can install it. paseo-plugins shipped one (#54 there) and needed a second pull request.
 * - **A bump to a version that is not new** — one already tagged, or lower than the base's. The
 *   release workflow never moves a tag, so a reused version is skipped and the code under it never
 *   ships; a lower one sorts below what users have and no semver range ever offers it.
 *
 * The reverse, a bump with no changelog section, is caught by `check-plugin-consistency.mjs`,
 * which wants a section for the declared version. Only `package.json` is compared: the
 * consistency check already holds the lockfile's two copies of the version to it.
 *
 * Run as `node .github/scripts/check-changelog-bump.mjs <base-commit>` from the repository root,
 * with `<base-commit>` and the release tags present in the local clone. The comparison is two-dot,
 * base against the working tree's `HEAD`, which on a pull request is the merge GitHub built — so
 * it sees what the pull request would change in the base, and nothing the base changed since. An
 * empty `<base-commit>` (a run that is not for a pull request) has nothing to compare and passes.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, parseVersion, readPluginIds, releaseTag } from "./plugins.mjs";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

/** `package.json`'s version at `base`, or `undefined` when the plugin did not exist there. */
function baseVersion(base, dir) {
  const path = `${dir}/package.json`;
  if (git("ls-tree", "--name-only", base, "--", path).trim() === "") return undefined;
  return JSON.parse(git("show", `${base}:${path}`)).version;
}

function tagExists(tag) {
  return git("tag", "--list", tag).trim() !== "";
}

const [base] = process.argv.slice(2);
if (base === undefined) {
  console.error("usage: check-changelog-bump.mjs <base-commit>");
  process.exit(2);
}
if (base === "") {
  console.log("No base commit, so there is no pull request to compare. Nothing to check.");
  process.exit(0);
}

const ids = readPluginIds();
const changed = new Set(
  git("diff", "--name-only", base, "HEAD", "--", ...ids.map((id) => `${id}/CHANGELOG.md`))
    .split("\n")
    .filter(Boolean),
);

let failed = false;
function fail(file, id, message) {
  failed = true;
  // Annotates the pull request's Files tab as well as the log.
  console.log(`::error file=${file},title=${id}::${message}`);
}

for (const id of ids) {
  const changelog = `${id}/CHANGELOG.md`;
  const before = baseVersion(base, id);
  const after = JSON.parse(readFileSync(join(id, "package.json"), "utf8")).version;

  if (before !== after) {
    const tag = releaseTag(id, after);
    if (tagExists(tag)) {
      fail(`${id}/package.json`, id, `${id} moves to ${after}, but ${tag} already exists, and a release tag is never moved. Pick the next version.`);
      continue;
    }
    // An unparseable version is the consistency check's to report.
    const comparable = parseVersion(before) && parseVersion(after);
    if (comparable && compareVersions(after, before) < 0) {
      fail(`${id}/package.json`, id, `${id} moves backwards, ${before} → ${after}. No semver range would offer it to anyone on ${before}.`);
      continue;
    }
    console.log(`✓ ${id}: ${before === undefined ? "new plugin, first version" : `version ${before} →`} ${after}`);
    continue;
  }

  if (!changed.has(changelog)) {
    console.log(`✓ ${id}: CHANGELOG.md and version unchanged`);
    continue;
  }
  fail(
    changelog,
    id,
    `${changelog} changed but ${id}/package.json is still ${after}. Merging a version bump is` +
      ` what releases a plugin, so this entry would reach main and never be released.`,
  );
}

if (failed) {
  console.error(
    "\nBump the version in the plugin folder (`npm version <patch|minor|major> --no-git-tag-version`" +
      " keeps the lockfile in step) and put the entry under the new `## x.y.z` heading.",
  );
  process.exit(1);
}
