#!/usr/bin/env node
/**
 * Checks the files inside each plugin folder that have to agree with each other, and that nothing
 * but a human keeps in step.
 *
 * There is no workspace root here, so no tool sees a plugin whole: `tsc` reads the TypeScript,
 * `vitest` reads the tests, `bb plugin build` reads the entries — and the files that declare *what
 * this plugin is* are checked by nobody. paseo-plugins learnt this the expensive way: a hand edit
 * pinned the SDK in five `package.json`s without regenerating a single lockfile, every gate stayed
 * green (`npm ci` only asks whether the locked tree *satisfies* `package.json`), and the drift was
 * found on `main` by hand.
 *
 * What is checked, per plugin listed in `.bb/plugins.json`:
 *
 * - **The index itself.** Every top-level folder with a `package.json` is listed, so a new plugin
 *   cannot be forgotten by CI and the release workflow, which both read the list from there.
 * - **Identity.** bb takes the plugin id from the package name's last segment minus `bb-plugin-`,
 *   and the tag prefix, the folder and the marketplace entry are all named by that id.
 * - **The version**, as `X.Y.Z` (the only tag shape the marketplace matches), in `package.json` and
 *   twice in the lockfile, and as a section of `CHANGELOG.md`. Merging a version bump is what
 *   releases a plugin, and the release refuses a version with nothing to read — better that the
 *   pull request hears it than the merge.
 * - **The lockfile's copy of the dependency blocks**, compared by name and range.
 * - **The bb manifest**: the required fields, and every entry and branding file it names exists.
 *   A missing `bb.app` file fails only in `bb plugin build`; a missing icon file fails at install.
 * - **The SDK pin.** `@get-bb/plugin-sdk` is pinned exactly (`bb plugin types` writes it that way)
 *   and satisfies the plugin's own `engines.bbPluginSdk`, so the plugin is never typed against an
 *   SDK older than it claims to need.
 * - **The scripts the CI matrix runs**: `typecheck` and `test`.
 * - **`PLUGIN_OVERVIEW.md`**, which the marketplace copies verbatim: present, at most 4000
 *   characters, no leading `#` title. The marketplace validates the rest of its markdown itself.
 *
 * Run as `node .github/scripts/check-plugin-consistency.mjs` from the repository root. No
 * dependencies, so it runs before `npm ci` does and reports on every plugin rather than stopping
 * at the first.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLUGIN_INDEX,
  changelogSection,
  compareVersions,
  parseVersion,
  readPluginIds,
} from "./plugins.mjs";

/** The blocks npm mirrors from `package.json` into the lockfile's root package entry. */
const DEPENDENCY_BLOCKS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const SDK = "@get-bb/plugin-sdk";
const REQUIRED_SCRIPTS = ["typecheck", "test"];
const OVERVIEW_LIMIT = 4000;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Compares two dependency blocks by name and declared range. Order is not meaningful — npm writes
 * both sorted, but a hand edit need not — so this compares as a map rather than as text.
 */
function blockDifferences(name, fromPackage = {}, fromLock = {}) {
  const problems = [];
  for (const dep of new Set([...Object.keys(fromPackage), ...Object.keys(fromLock)])) {
    const declared = fromPackage[dep];
    const locked = fromLock[dep];
    if (declared === locked) continue;
    if (declared === undefined) {
      problems.push(`${name}.${dep} is in the lockfile (${locked}) but not in package.json`);
    } else if (locked === undefined) {
      problems.push(`${name}.${dep} is in package.json (${declared}) but not in the lockfile`);
    } else {
      problems.push(`${name}.${dep} is ${declared} in package.json but ${locked} in the lockfile`);
    }
  }
  return problems;
}

/** The files `bb` names by path: its entries and its branding images. */
function manifestPaths(bb) {
  const paths = [bb.server, bb.app, bb.host];
  const { branding = {} } = bb;
  if (typeof branding.icon === "string" && branding.icon.startsWith("./")) paths.push(branding.icon);
  paths.push(branding.logo?.light, branding.logo?.dark);
  paths.push(...Object.values(branding.experimental_icons ?? {}));
  return paths.filter((path) => typeof path === "string");
}

function checkManifest(dir, bb) {
  if (bb === undefined) return ['package.json has no "bb" manifest block'];
  const problems = [];
  for (const field of ["name", "description", "server"]) {
    if (typeof bb[field] !== "string" || bb[field].trim() === "") {
      problems.push(`bb.${field} is missing`);
    }
  }
  if (!bb.branding?.icon && !bb.branding?.logo?.light) {
    problems.push("bb.branding needs an icon or a logo.light");
  }
  for (const path of manifestPaths(bb)) {
    if (!existsSync(join(dir, path))) problems.push(`the bb manifest names ${path}, which does not exist`);
  }
  return problems;
}

/** The SDK pin is exact and at least the `>=X.Y.Z` the plugin declares it needs. */
function checkSdk(pkg) {
  const pin = pkg.dependencies?.[SDK] ?? pkg.devDependencies?.[SDK];
  const engine = pkg.engines?.bbPluginSdk;
  const problems = [];
  if (pkg.engines?.bb === undefined) problems.push("engines.bb is missing");
  if (pin === undefined) return [...problems, `${SDK} is not a dependency`];
  if (!parseVersion(pin)) {
    return [...problems, `${SDK} is "${pin}"; pin it exactly, as \`bb plugin types\` does`];
  }
  const minimum = /^>=\s*(\d+\.\d+\.\d+)$/.exec(engine ?? "")?.[1];
  if (minimum === undefined) {
    problems.push(`engines.bbPluginSdk is "${engine}"; expected ">=X.Y.Z"`);
  } else if (compareVersions(pin, minimum) < 0) {
    problems.push(`${SDK} is pinned to ${pin}, older than engines.bbPluginSdk ${engine}`);
  }
  return problems;
}

function checkOverview(dir) {
  const path = join(dir, "PLUGIN_OVERVIEW.md");
  if (!existsSync(path)) return ["PLUGIN_OVERVIEW.md is missing; the marketplace listing needs it"];
  const overview = readFileSync(path, "utf8");
  const problems = [];
  // Characters, as the marketplace counts them, not UTF-16 units.
  const length = [...overview].length;
  if (length > OVERVIEW_LIMIT) {
    problems.push(`PLUGIN_OVERVIEW.md is ${length} characters; the marketplace takes ${OVERVIEW_LIMIT}`);
  }
  if (/^\s*# /.test(overview)) {
    problems.push("PLUGIN_OVERVIEW.md starts with a # title; the store page supplies the title");
  }
  return problems;
}

function checkPlugin(id) {
  const dir = id;
  const problems = [];

  const pkg = readJson(join(dir, "package.json"));
  const lock = readJson(join(dir, "package-lock.json"));
  const root = lock.packages?.[""] ?? {};

  if (String(pkg.name).split("/").pop() !== `bb-plugin-${id}`) {
    problems.push(`package name ${pkg.name} does not end in bb-plugin-${id}, so bb would give it another id`);
  }
  if (pkg.repository?.directory !== id) {
    problems.push(`repository.directory is ${pkg.repository?.directory}, expected ${id}`);
  }

  if (!parseVersion(pkg.version)) {
    problems.push(`version ${pkg.version} is not X.Y.Z, the only shape a release tag can take`);
  }
  // The version appears three times and npm writes all three. A hand-bumped `package.json` leaves
  // the other two behind, which is invisible until somebody reads a lockfile.
  if (lock.version !== pkg.version) {
    problems.push(`lockfile version is ${lock.version}, package.json says ${pkg.version}`);
  }
  if (root.version !== pkg.version) {
    problems.push(`lockfile packages[""].version is ${root.version}, package.json says ${pkg.version}`);
  }
  for (const block of DEPENDENCY_BLOCKS) {
    problems.push(...blockDifferences(block, pkg[block], root[block]));
  }

  const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
  if (changelogSection(changelog, pkg.version) === undefined) {
    problems.push(`CHANGELOG.md has no "## ${pkg.version}" section for the declared version`);
  }

  problems.push(...checkManifest(dir, pkg.bb));
  problems.push(...checkSdk(pkg));
  for (const script of REQUIRED_SCRIPTS) {
    if (!pkg.scripts?.[script]) problems.push(`package.json has no "${script}" script; CI runs it`);
  }
  problems.push(...checkOverview(dir));

  return problems;
}

/** Top-level folders holding a `package.json` that the index does not list. */
function unlistedPlugins(ids) {
  return readdirSync(".", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(name, "package.json")) && !ids.includes(name));
}

let failed = false;
function report(file, title, problem) {
  failed = true;
  // Annotates the pull request's Files tab as well as the log.
  console.log(`::error file=${file},title=${title}::${problem}`);
}

const ids = readPluginIds();
for (const name of unlistedPlugins(ids)) {
  report(PLUGIN_INDEX, name, `${name}/ has a package.json but is not in ${PLUGIN_INDEX}, so CI and releases skip it`);
}
for (const id of ids) {
  if (!existsSync(join(id, "package.json"))) {
    report(PLUGIN_INDEX, id, `${PLUGIN_INDEX} lists ${id}, but ${id}/package.json does not exist`);
    continue;
  }
  const problems = checkPlugin(id);
  if (problems.length === 0) {
    console.log(`✓ ${id}`);
    continue;
  }
  for (const problem of problems) report(`${id}/package.json`, id, problem);
}

if (failed) {
  console.error(
    "\nRun `npm install` in the plugin folder to rewrite its lockfile, add the changelog section" +
      " if the version moved, and list every plugin folder in .bb/plugins.json.",
  );
  process.exit(1);
}
