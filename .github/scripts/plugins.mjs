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
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PLUGIN_INDEX = ".bb/plugins.json";

const SCHEMA_URL = "https://getbb.app/schemas/plugins.schema.json";
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Everything wrong with a parsed `.bb/plugins.json`, by the rules of bb's own schema
 * (`https://getbb.app/schemas/plugins.schema.json`, mirrored by hand because the scripts take no
 * dependencies): only the known fields, `schemaVersion` 1, names of lowercase letters, digits and
 * dashes, and unique entry names. bb refuses a git install from a repository whose index breaks any
 * of these, so the pull request has to hear it, not the next person to install.
 *
 * One rule is stricter than bb's: each source is `./<name>`. The tag prefix, the matrix job and the
 * folder are all named by the id, and nothing here maps one to another.
 */
export function validatePluginIndex(index) {
  if (typeof index !== "object" || index === null || Array.isArray(index)) {
    return ["the index is not a JSON object"];
  }
  const problems = [];
  for (const key of Object.keys(index)) {
    if (!["$schema", "schemaVersion", "name", "plugins"].includes(key)) {
      problems.push(`unknown field "${key}"`);
    }
  }
  if ("$schema" in index && index.$schema !== SCHEMA_URL) {
    problems.push(`"$schema" is ${JSON.stringify(index.$schema)}; expected "${SCHEMA_URL}"`);
  }
  if (index.schemaVersion !== 1) {
    problems.push(`"schemaVersion" is ${JSON.stringify(index.schemaVersion)}; bb reads only 1`);
  }
  if (typeof index.name !== "string" || !NAME.test(index.name)) {
    problems.push(`"name" is ${JSON.stringify(index.name)}; expected lowercase letters, digits and dashes`);
  }
  if (!Array.isArray(index.plugins) || index.plugins.length === 0) {
    problems.push(`"plugins" must be a non-empty array`);
    return problems;
  }
  const seen = new Set();
  index.plugins.forEach((entry, i) => {
    const where = `plugins[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push(`${where} is not an object`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (key !== "name" && key !== "source") problems.push(`${where} has unknown field "${key}"`);
    }
    if (typeof entry.name !== "string" || !NAME.test(entry.name)) {
      problems.push(`${where}.name is ${JSON.stringify(entry.name)}; expected lowercase letters, digits and dashes`);
      return;
    }
    if (seen.has(entry.name)) problems.push(`${where}: "${entry.name}" is listed twice`);
    seen.add(entry.name);
    if (entry.source !== `./${entry.name}`) {
      problems.push(`${where}: "${entry.name}" has source ${JSON.stringify(entry.source)}; it must be "./${entry.name}"`);
    }
  });
  return problems;
}

/** The plugin ids in `.bb/plugins.json`, in its order; throws when the index is invalid. */
export function readPluginIds(root = ".") {
  const index = JSON.parse(readFileSync(join(root, PLUGIN_INDEX), "utf8"));
  const problems = validatePluginIndex(index);
  if (problems.length > 0) {
    throw new Error(`${PLUGIN_INDEX} is invalid:\n- ${problems.join("\n- ")}`);
  }
  return index.plugins.map((entry) => entry.name);
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

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** `<id>/package.json`'s version at `commit`, or `undefined` when the file is absent there. */
function versionAt(root, commit, id) {
  try {
    return JSON.parse(git(root, "show", `${commit}:${id}/package.json`)).version;
  } catch {
    return undefined;
  }
}

/**
 * The commit on `HEAD`'s first-parent history that brought `<id>/package.json` to the version it
 * has now — the merge of the pull request that bumped it, on a squash-merged `main`. That, not the
 * newest commit, is what a release tags: a later push that changed the plugin without bumping it is
 * not part of this version, and a run that was cancelled, queued behind another or failed is
 * finished by any later run tagging the same commit. Throws when there is no such commit.
 */
export function introducingCommit(id, root = ".") {
  const version = versionAt(root, "HEAD", id);
  const commits = git(root, "log", "--first-parent", "--format=%H", "HEAD", "--", `${id}/package.json`)
    .split("\n")
    .filter(Boolean);
  let introducing;
  for (const commit of commits) {
    if (version === undefined || versionAt(root, commit, id) !== version) break;
    introducing = commit;
  }
  if (introducing === undefined) throw new Error(`no commit on HEAD's history gives ${id} a version`);
  return introducing;
}

/**
 * Which plugins a release run has work for, and why: a version with no tag yet, or a tag with no
 * GitHub release — a run that pushed the tag and then failed, or a tag cut by hand. Pure, so the
 * lookups are passed in.
 */
export function pluginsToRelease(ids, { versionOf, tagExists, releaseExists }) {
  const chosen = [];
  for (const id of ids) {
    const tag = releaseTag(id, versionOf(id));
    if (!tagExists(tag)) chosen.push({ id, tag, reason: "no tag" });
    else if (!releaseExists(tag)) chosen.push({ id, tag, reason: "tag without a GitHub release" });
  }
  return chosen;
}
