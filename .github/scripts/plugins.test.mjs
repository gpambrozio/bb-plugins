// Run with `node --test ".github/scripts/*.test.mjs"` from the repository root.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  changelogSection,
  compareVersions,
  parseVersion,
  readPluginIds,
  releaseTag,
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
  writeFileSync(join(root, ".bb", "plugins.json"), JSON.stringify({ plugins }));
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
