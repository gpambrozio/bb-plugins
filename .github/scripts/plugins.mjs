/**
 * What the CI and release scripts share: which plugins this repository has, and how to read a
 * plugin's version and its changelog.
 *
 * The plugin list is `.bb/plugins.json`, the collection manifest bb itself reads to install one
 * plugin out of this repository. Reading it here rather than spelling the list out in each
 * workflow means a new plugin is added in exactly one place, and that place is the one bb needs
 * anyway: a plugin missing from it could not be installed, and now it is not checked or released
 * either — which `check-plugin-consistency.mjs` turns into a failure rather than a silence.
 *
 * Plain Node, no dependencies, so every script runs before `npm ci` does.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PLUGIN_INDEX = ".bb/plugins.json";

/**
 * The plugin ids in `.bb/plugins.json`, in its order. Each id is also its folder: an entry whose
 * source is not `./<name>` is refused, because the tag prefix, the matrix job and the folder are
 * all named by the id and nothing here maps one to another.
 */
export function readPluginIds(root = ".") {
  const index = JSON.parse(readFileSync(join(root, PLUGIN_INDEX), "utf8"));
  if (!Array.isArray(index.plugins) || index.plugins.length === 0) {
    throw new Error(`${PLUGIN_INDEX} has no "plugins" array`);
  }
  return index.plugins.map((entry) => {
    if (entry.source !== `./${entry.name}`) {
      throw new Error(
        `${PLUGIN_INDEX}: "${entry.name}" has source "${entry.source}"; it must be "./${entry.name}"`,
      );
    }
    return entry.name;
  });
}

/**
 * `X.Y.Z` as three numbers, or `undefined` for anything else. Release tags are `<id>/vX.Y.Z` and
 * the Community marketplace matches exactly that shape, so a prerelease or build suffix would cut
 * a tag no install could find.
 */
export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  return match ? match.slice(1).map(Number) : undefined;
}

/** Negative, zero or positive as `a` sorts before, with or after `b`. Both must parse. */
export function compareVersions(a, b) {
  const [left, right] = [parseVersion(a), parseVersion(b)];
  if (!left || !right) throw new Error(`cannot compare "${a}" with "${b}"`);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

export function releaseTag(id, version) {
  return `${id}/v${version}`;
}

/**
 * Whether `line` is the heading of `version`'s section. The changelogs here write `## 0.2.0`;
 * Keep a Changelog writes `## [0.2.0] - 2026-01-01`. Both are accepted, so a changelog written
 * either way releases, and `## 0.2.0-beta` or `## 0.2.01` are not mistaken for `0.2.0`.
 */
function isVersionHeading(line, version) {
  const escaped = version.replaceAll(".", "\\.");
  return new RegExp(`^## (\\[${escaped}\\]|${escaped})(\\s|$)`).test(line);
}

/**
 * The section of `changelog` for `version`, heading included and trailing blank lines dropped, or
 * `undefined` when there is none. It ends at the next `## ` heading, so `###` subsections stay in.
 */
export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => isVersionHeading(line, version));
  if (start === -1) return undefined;
  let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  if (end === -1) end = lines.length;
  return lines.slice(start, end).join("\n").trimEnd();
}
