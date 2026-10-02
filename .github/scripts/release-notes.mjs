#!/usr/bin/env node
/**
 * Prints the GitHub release notes for one plugin at the version its `package.json` declares: how
 * to install it, then that version's section of its `CHANGELOG.md`.
 *
 * A release is three things to a user: a version to install, a tag to pin, and an entry to read
 * before they move. The workflow makes the first two automatically, so this is where the third is
 * enforced — a version with no changelog section exits non-zero instead of shipping notes that say
 * nothing. `check-plugin-consistency.mjs` asks the same question of the pull request; this asks it
 * again of the commit actually being released.
 *
 * Run as `node .github/scripts/release-notes.mjs <plugin-dir> <owner/repo>`. `<plugin-dir>` may be
 * anywhere — the release workflow reads it from a worktree of the commit it tags — and its folder
 * name is the plugin id.
 */
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { changelogSection } from "./plugins.mjs";

const [dir, repository] = process.argv.slice(2);
if (dir === undefined || repository === undefined) {
  console.error("usage: release-notes.mjs <plugin-dir> <owner/repo>");
  process.exit(2);
}

const id = basename(resolve(dir));
const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const section = changelogSection(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), version);
if (section === undefined) {
  console.error(
    `::error file=${id}/CHANGELOG.md,title=${id}::${id}/CHANGELOG.md has no "## ${version}" section.` +
      " A release is a version to install and an entry to read; this one would have nothing to read.",
  );
  process.exit(1);
}

// The range follows this release and every compatible one after it, which is what the README
// and the marketplace entries install.
console.log(
  [
    "```bash",
    `bb plugin install 'git:github.com/${repository}@^${version}' --plugin ${id} --tag-prefix ${id}/`,
    "```",
    "",
    section,
  ].join("\n"),
);
