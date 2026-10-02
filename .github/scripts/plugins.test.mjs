// Run with `node --test ".github/scripts/*.test.mjs"` from the repository root.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  changelogSection,
  compareVersions,
  introducingCommit,
  parseVersion,
  pluginsToRelease,
  readPluginIds,
  releaseTag,
  validatePluginIndex,
} from "./plugins.mjs";

const CHANGELOG = `# Changelog

Notable changes.

## 0.2.0

### Added

- **Something new.**

## 0.1.0

The first release.
`;

test("changelogSection takes the version's section, subsections included", () => {
  assert.equal(changelogSection(CHANGELOG, "0.2.0"), "## 0.2.0\n\n### Added\n\n- **Something new.**");
  assert.equal(changelogSection(CHANGELOG, "0.1.0"), "## 0.1.0\n\nThe first release.");
});

test("changelogSection accepts Keep a Changelog headings", () => {
  const text = "## [Unreleased]\n\n## [1.0.0] - 2026-10-01\n\n- Done.\n";
  assert.equal(changelogSection(text, "1.0.0"), "## [1.0.0] - 2026-10-01\n\n- Done.");
});

test("changelogSection does not mistake a longer version for the one asked", () => {
  const text = "## 0.2.01\n\n## 0.2.0-beta\n\n## 10.2.0\n";
  assert.equal(changelogSection(text, "0.2.0"), undefined);
  assert.equal(changelogSection(CHANGELOG, "0.3.0"), undefined);
});

test("parseVersion takes only X.Y.Z", () => {
  assert.deepEqual(parseVersion("1.20.3"), [1, 20, 3]);
  assert.equal(parseVersion("1.2.3-beta.1"), undefined);
  assert.equal(parseVersion("v1.2.3"), undefined);
  assert.equal(parseVersion(undefined), undefined);
});

test("compareVersions compares numerically", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("0.1.0", "0.2.0") < 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

test("releaseTag is <id>/v<version>", () => {
  assert.equal(releaseTag("herald", "0.2.0"), "herald/v0.2.0");
});

function repoWith(plugins) {
  const root = mkdtempSync(join(tmpdir(), "plugins-test-"));
  mkdirSync(join(root, ".bb"));
  writeFileSync(join(root, ".bb", "plugins.json"), JSON.stringify({ schemaVersion: 1, name: "test", plugins }));
  return root;
}

test("readPluginIds lists the index in order", () => {
  const root = repoWith([
    { name: "herald", source: "./herald" },
    { name: "skills", source: "./skills" },
  ]);
  assert.deepEqual(readPluginIds(root), ["herald", "skills"]);
});

test("readPluginIds refuses a source that is not the id's folder", () => {
  const root = repoWith([{ name: "herald", source: "./plugins/herald" }]);
  assert.throws(() => readPluginIds(root), /must be "\.\/herald"/);
});

const VALID_INDEX = {
  $schema: "https://getbb.app/schemas/plugins.schema.json",
  schemaVersion: 1,
  name: "gpambrozio-bb-plugins",
  plugins: [
    { name: "github-board", source: "./github-board" },
    { name: "herald", source: "./herald" },
  ],
};

test("validatePluginIndex accepts this repository's index", () => {
  const index = JSON.parse(readFileSync(new URL("../../.bb/plugins.json", import.meta.url), "utf8"));
  assert.deepEqual(validatePluginIndex(index), []);
  assert.deepEqual(validatePluginIndex(VALID_INDEX), []);
});

test("validatePluginIndex refuses what bb's schema refuses, and duplicates", () => {
  const index = {
    ...VALID_INDEX,
    schemaVersion: 99,
    extra: true,
    plugins: [
      ...VALID_INDEX.plugins,
      { name: "github-board", source: "./github-board" },
      { name: "Bad_Name", source: "./Bad_Name" },
      { name: "skills", source: "./skills", ref: "main" },
    ],
  };
  const problems = validatePluginIndex(index);
  assert.ok(problems.some((p) => p.includes('"schemaVersion" is 99')), problems.join("\n"));
  assert.ok(problems.some((p) => p.includes('unknown field "extra"')));
  assert.ok(problems.some((p) => p.includes('"github-board" is listed twice')));
  assert.ok(problems.some((p) => p.includes("plugins[3].name")));
  assert.ok(problems.some((p) => p.includes('plugins[4] has unknown field "ref"')));
});

test("validatePluginIndex refuses a missing name, schema URL or empty list", () => {
  const { name, ...nameless } = VALID_INDEX;
  assert.ok(validatePluginIndex(nameless).some((p) => p.startsWith('"name"')));
  assert.ok(validatePluginIndex({ ...VALID_INDEX, $schema: "x" }).some((p) => p.startsWith('"$schema"')));
  assert.ok(validatePluginIndex({ ...VALID_INDEX, plugins: [] }).some((p) => p.includes("non-empty")));
});

test("pluginsToRelease takes untagged versions and tags without a release", () => {
  const versions = { herald: "0.3.0", skills: "0.1.0", board: "0.1.0" };
  const tags = new Set(["skills/v0.1.0", "board/v0.1.0"]);
  const releases = new Set(["board/v0.1.0"]);
  const chosen = pluginsToRelease(["herald", "skills", "board"], {
    versionOf: (id) => versions[id],
    tagExists: (tag) => tags.has(tag),
    releaseExists: (tag) => releases.has(tag),
  });
  assert.deepEqual(chosen, [
    { id: "herald", tag: "herald/v0.3.0", reason: "no tag" },
    { id: "skills", tag: "skills/v0.1.0", reason: "tag without a GitHub release" },
  ]);
});

/** A throwaway repository with one commit per step; returns the root and each step's commit. */
function historyOf(steps) {
  const root = mkdtempSync(join(tmpdir(), "plugins-history-"));
  const run = (...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" });
  run("init", "-q", "-b", "main");
  mkdirSync(join(root, "herald"));
  return {
    root,
    commits: steps.map(({ version, file = "package.json", content }, step) => {
      const path = join(root, "herald", file);
      writeFileSync(path, content ?? JSON.stringify({ version, step }));
      run("add", "-A");
      run("commit", "-q", "-m", `step ${file}`);
      return run("rev-parse", "HEAD").trim();
    }),
  };
}

test("introducingCommit finds the bump, past later changes that kept the version", () => {
  const { root, commits } = historyOf([
    { version: "0.1.0" },
    { version: "0.2.0" },
    { version: "0.2.0" }, // a dependency change, same version
    { file: "server.ts", content: "export {};" },
  ]);
  assert.equal(introducingCommit("herald", root), commits[1]);
});

test("introducingCommit takes the latest run of the version, not an earlier one", () => {
  const { root, commits } = historyOf([{ version: "0.1.0" }, { version: "0.2.0" }, { version: "0.1.0" }]);
  assert.equal(introducingCommit("herald", root), commits[2]);
});

test("introducingCommit throws for a plugin that is not there", () => {
  const { root } = historyOf([{ version: "0.1.0" }]);
  assert.throws(() => introducingCommit("skills", root), /no commit/);
});
