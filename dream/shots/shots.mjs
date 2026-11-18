// Shot list for Dream. Run with `SHOTS_ROOT=/tmp/bbss npm run shots -- dream` in tools/shots; it writes
// into dream/docs/screenshots/. The short root only shortens the fixture paths the page prints (the
// default root is under $TMPDIR); any root works.
//
// The shots: the page (with the sidebar badge), a project's details, a dry run's proposal, the history
// and the settings, light and dark. The light ones are also the BB Community marketplace's screenshots
// (screenshots/dream/ in get-bb/marketplace): each at least 1200 pixels wide and well under 2 MiB, in the
// order page, proposal, history, project, settings.
//
// Four fixture projects, each a git repository the harness makes, with Claude Code's memory and session
// transcripts written into the dev bb's fake HOME as Claude Code would leave them:
//
// - Acme Web: never dreamed, with a dry run waiting (its proposal is written as the host leaves one: a
//   copy of the memory with the dream's edits, the memory as it was, and the record);
// - Acme API: dreamed in place four days ago (its lock's time), with enough sessions since to be due;
// - Mobile App: a custom memory folder set only in settings.local.json, so the page warns that its
//   worktrees use another folder; too few sessions yet;
// - Docs Site: no memory at all.
//
// No dream runs: a dream needs a real Claude Code session, and the dev bb has only a stub. The run
// history the History tab reads is the server's own log of finished runs, written into the dev bb's
// plugin storage before the plugin is reloaded. The schedule stays off, as it is by default.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PLUGIN = "dream";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();

/** Claude Code's folder name for a path (short paths only, as these are). */
const slug = (dir) => dir.replace(/[^A-Za-z0-9]/g, "-");

function write(file, content, mtimeMs) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mtimeMs !== undefined) utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

function writeFiles(dir, files, mtimeMs) {
  for (const [name, content] of Object.entries(files)) write(join(dir, name), content, mtimeMs);
}

/** One Claude Code session transcript, titled as Claude Code titles one, last written `ageMs` ago. */
function transcript(folder, title, ageMs) {
  const lines = [
    { type: "user", message: { role: "user", content: title } },
    { type: "ai-title", aiTitle: title },
    { type: "assistant", message: { role: "assistant", content: "Done." } },
  ];
  write(join(folder, `${randomUUID()}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, NOW - ageMs);
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const WEB_MEMORY = {
  "MEMORY.md": `- [Build and test](build.md) — npm scripts, Jest
- [Deploys](deploy.md) — staging first, then production
- [Old staging host](old_staging.md) — staging lives on the old VM
- [Small pull requests](feedback_small_prs.md) — one change per PR
- [Who I work with](user_profile.md) — front-end lead, prefers terse reviews
`,
  "build.md": `---
name: build
description: How Acme Web builds and tests
type: project
---

Build with \`npm run build\`. Tests run with Jest: \`npm test\`.
End-to-end tests are in \`e2e/\` and need the dev server on port 3000.
`,
  "deploy.md": `---
name: deploy
description: Deploys
type: project
---

Every merge to main deploys to staging. Production deploys by hand on Tuesdays.
`,
  "old_staging.md": `---
name: old-staging
description: Where staging runs
type: reference
---

Staging runs on the old VM, staging-1. SSH in to read its logs.
`,
  "feedback_small_prs.md": `---
name: small-prs
description: Keep pull requests small
type: feedback
---

One change per pull request. **Why:** reviews of mixed PRs stalled for days.
`,
  "user_profile.md": `---
name: user-profile
description: Who I work with
type: user
---

Front-end lead on Acme Web. Prefers terse reviews and screenshots of UI changes.
`,
};

/** What the dry run would leave: Jest became Vitest, staging moved, a nightly run was added. */
const WEB_PROPOSED = {
  "MEMORY.md": `- [Build and test](build.md) — npm scripts, Vitest
- [Deploys](deploy.md) — staging on every merge, production on Tuesdays
- [Nightly end-to-end run](ci_nightly.md) — what fails it and how to rerun it
- [Small pull requests](feedback_small_prs.md) — one change per PR
- [Who I work with](user_profile.md) — front-end lead, prefers terse reviews
`,
  "build.md": `---
name: build
description: How Acme Web builds and tests
type: project
---

Build with \`npm run build\`. Tests run with Vitest: \`npm test\` (moved from Jest in March).
End-to-end tests are in \`e2e/\` and need the dev server on port 3000.
`,
  "deploy.md": `---
name: deploy
description: Deploys
type: project
---

Every merge to main deploys to staging, now on the container platform (logs in its dashboard).
Production deploys by hand on Tuesdays.
`,
  "ci_nightly.md": `---
name: ci-nightly
description: The nightly end-to-end run
type: project
---

The nightly run fails when the browser runs out of memory, not on a real bug. Rerun it with
\`npm run test:e2e -- --workers=2\`.
`,
  "feedback_small_prs.md": WEB_MEMORY["feedback_small_prs.md"],
  "user_profile.md": WEB_MEMORY["user_profile.md"],
};

const WEB_SUMMARY = `Looked at all 9 sessions since the memory began and checked each memory against the code.

- **build.md**: the tests moved from Jest to Vitest (package.json, vitest.config.ts).
- **deploy.md**: staging moved to the container platform; the old VM is gone.
- **old_staging.md**: deleted, superseded by deploy.md; the index no longer links it.
- **ci_nightly.md**: new, from three sessions that chased the same nightly failure.`;

const API_MEMORY = {
  "MEMORY.md": `- [Rate limits](rate_limits.md) — 100 requests a minute per key
- [Database](database.md) — Postgres 16, migrations in db/
- [API reference](reference_docs.md) — published from openapi.yaml
`,
  "rate_limits.md": "---\nname: rate-limits\ndescription: Rate limits\ntype: project\n---\n\n100 requests a minute per API key, then 429 with Retry-After.\n",
  "database.md": "---\nname: database\ndescription: The database\ntype: project\n---\n\nPostgres 16. Migrations are in `db/` and run with `npm run migrate`.\n",
  "reference_docs.md": "---\nname: reference-docs\ndescription: The API reference\ntype: reference\n---\n\nPublished from `openapi.yaml` on every release.\n",
};

const MOBILE_MEMORY = {
  "MEMORY.md": "- [Builds](builds.md) — Xcode 26, one scheme per app\n",
  "builds.md": "---\nname: builds\ndescription: Builds\ntype: project\n---\n\nOne scheme per app; the widget builds with the main app.\n",
};

/** The run history the History tab shows, newest first once listed. */
function runs(projects) {
  const record = (fields) => ({
    hostId: "local",
    threadId: null,
    backup: null,
    proposal: null,
    error: null,
    summary: null,
    changes: null,
    danglingLinks: [],
    ...fields,
  });
  return [
    record({
      runId: "run-api-dry",
      projectId: projects.api.id,
      projectName: "Acme API",
      mode: "dry-run",
      trigger: "schedule",
      startedAt: NOW - 9 * DAY,
      endedAt: NOW - 9 * DAY + 14 * 60_000,
      outcome: "proposed",
      changes: { added: ["reference_docs.md"], changed: ["MEMORY.md", "database.md"], deleted: [] },
      proposal: stamp(NOW - 9 * DAY),
      summary: "Looked at all 12 sessions and checked each memory against the code.\n\n- **database.md**: Postgres 15 → 16.\n- **reference_docs.md**: new; the reference is published from openapi.yaml.",
    }),
    record({
      runId: "run-api-dream",
      projectId: projects.api.id,
      projectName: "Acme API",
      mode: "dream",
      trigger: "schedule",
      startedAt: NOW - 4 * DAY,
      endedAt: NOW - 4 * DAY + 11 * 60_000,
      outcome: "changed",
      changes: { added: [], changed: ["MEMORY.md", "rate_limits.md"], deleted: [] },
      backup: stamp(NOW - 4 * DAY),
      summary:
        "Looked at all 6 sessions since the last dream and checked each memory against the code.\n\n- **rate_limits.md**: the limit is per API key now, not per IP (src/middleware/rate-limit.ts).\n- **MEMORY.md**: its line for rate limits says so.",
    }),
    record({
      runId: "run-web-dry",
      projectId: projects.web.id,
      projectName: "Acme Web",
      mode: "dry-run",
      trigger: "manual",
      startedAt: NOW - 3 * HOUR,
      endedAt: NOW - 3 * HOUR + 17 * 60_000,
      outcome: "proposed",
      changes: { added: ["ci_nightly.md"], changed: ["MEMORY.md", "build.md", "deploy.md"], deleted: ["old_staging.md"] },
      proposal: stamp(NOW - 3 * HOUR),
      summary: WEB_SUMMARY,
    }),
  ];
}

/** A time as the plugin names a backup or proposal. */
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:.]/g, "");

export async function seed({ bb, seed }) {
  const home = seed.home;
  const claudeProjects = join(home, ".claude", "projects");
  const projects = {
    web: seed.project("Acme Web", { "README.md": "# Acme Web\n", "package.json": '{ "name": "acme-web" }\n' }),
    api: seed.project("Acme API", { "README.md": "# Acme API\n" }),
    mobile: seed.project("Mobile App", { "README.md": "# Mobile App\n" }),
    docs: seed.project("Docs Site", { "README.md": "# Docs Site\n" }),
  };
  const folder = (project) => join(claudeProjects, slug(realpathSync(project.path)));

  // Acme Web: nine sessions over four days, the memory written by sessions, no dream yet.
  writeFiles(join(folder(projects.web), "memory"), WEB_MEMORY, NOW - 2 * DAY);
  [
    ["Fix the flaky checkout test", 4 * DAY],
    ["Move the tests from Jest to Vitest", 4 * DAY - 2 * HOUR],
    ["Why does the nightly end-to-end run fail?", 3 * DAY],
    ["Rerun the nightly with two workers", 3 * DAY - HOUR],
    ["Move staging to the container platform", 2 * DAY],
    ["Add dark mode to the header", 2 * DAY - 3 * HOUR],
    ["Nightly run failed again", 26 * HOUR],
    ["Review the sign-up form", 6 * HOUR],
    ["Fix the login redirect", 5 * HOUR],
  ].forEach(([title, age]) => transcript(folder(projects.web), title, age));

  // Acme API: dreamed in place four days ago; seven sessions on three days since.
  const apiMemory = join(folder(projects.api), "memory");
  writeFiles(apiMemory, API_MEMORY, NOW - 4 * DAY);
  write(join(apiMemory, ".consolidate-lock"), "", NOW - 4 * DAY);
  [
    ["Add pagination to /orders", 3 * DAY],
    ["Fix the 429 header", 3 * DAY - HOUR],
    ["Upgrade the Postgres driver", 2 * DAY],
    ["Write the webhooks guide", 2 * DAY - 2 * HOUR],
    ["Add full-text search", 30 * HOUR],
    ["Search ranking tweaks", 28 * HOUR],
    ["Fix the search index migration", 7 * HOUR],
  ].forEach(([title, age]) => transcript(folder(projects.api), title, age));

  // Mobile App: its memory folder is set only in settings.local.json, which its worktrees lack.
  write(join(projects.mobile.path, ".claude", "settings.local.json"), `${JSON.stringify({ autoMemoryDirectory: "~/agent-memory/mobile-app" }, null, 2)}\n`);
  writeFiles(join(home, "agent-memory", "mobile-app"), MOBILE_MEMORY, NOW - 5 * DAY);
  [
    ["Fix the widget's refresh", 5 * DAY],
    ["Add the iPad layout", 2 * DAY],
    ["Crash on launch in the simulator", 9 * HOUR],
  ].forEach(([title, age]) => transcript(folder(projects.mobile), title, age));

  // Docs Site: sessions, but no memory.
  transcript(folder(projects.docs), "Fix the broken links in the guides", DAY);

  // The host's records: Acme Web's waiting dry run, and Acme API's dreams.
  const hostData = join(bb.cfg.data, "plugins", PLUGIN, "host-data");
  const proposal = join(hostData, "proposals", projects.web.id, stamp(NOW - 3 * HOUR));
  writeFiles(join(proposal, "memory"), WEB_PROPOSED);
  write(join(proposal, "base.json"), `${JSON.stringify(Object.fromEntries(Object.entries(WEB_MEMORY).map(([name, text]) => [name, sha256(text)])), null, 2)}\n`);
  write(
    join(proposal, "proposal.json"),
    `${JSON.stringify(
      {
        stamp: stamp(NOW - 3 * HOUR),
        createdAt: NOW - 3 * HOUR,
        status: "ready",
        changes: { added: ["ci_nightly.md"], changed: ["MEMORY.md", "build.md", "deploy.md"], deleted: ["old_staging.md"] },
        summary: WEB_SUMMARY,
        appliedAt: null,
      },
      null,
      2,
    )}\n`,
  );
  write(
    join(hostData, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        projects: {
          [projects.api.id]: { name: "Acme API", inPlace: true, lastDreamAt: NOW - 4 * DAY, dreamThreadIds: [], dreamSessionIds: [], history: [] },
          [projects.web.id]: { name: "Acme Web", inPlace: false, dreamThreadIds: [], dreamSessionIds: [], history: [] },
        },
        runs: {},
      },
      null,
      2,
    )}\n`,
  );

  writeHistory(bb, runs(projects));
  bb.cli(["plugin", "reload", PLUGIN]);
  // The model the settings show: the stub Claude Code lists "opus" (Opus 5.5), not the full model id,
  // and no reasoning levels, so its picker shows Low. Saved as the picker can show it, the settings show
  // no "Not saved" draft.
  await seed.rpc(PLUGIN, "setChoices", { model: "opus", reasoningLevel: "low" });
}

/**
 * The server's run log, written into the dev bb's plugin storage (bb keeps a plugin's kv as JSON rows in
 * its own database), under the keys server/history.ts uses. Only the throwaway dev bb's database.
 */
function writeHistory(bb, records) {
  const rows = records.map((record) => {
    const key = `run:${String(record.startedAt).padStart(15, "0")}-${record.runId}`;
    const value = JSON.stringify(record).replace(/'/g, "''");
    return `INSERT OR REPLACE INTO plugin_kv (plugin_id, key, value, updated_at) VALUES ('${PLUGIN}', '${key}', '${value}', ${NOW});`;
  });
  execFileSync("sqlite3", [join(bb.cfg.data, "bb.db")], { input: `PRAGMA busy_timeout = 5000;\nBEGIN;\n${rows.join("\n")}\nCOMMIT;\n` });
}

/** Waits until the Dream page has read its projects. */
async function openDream(shots, variant) {
  const page = await shots.page(variant, `/plugins/${PLUGIN}/dream`);
  await page.getByText("Acme Web", { exact: true }).first().waitFor();
  await page.getByText("Mobile App", { exact: true }).first().waitFor();
  return page;
}

export async function shoot({ shots, VARIANTS }) {
  for (const [variant, theme] of [
    [VARIANTS.desktopLight, "light"],
    [VARIANTS.desktopDark, "dark"],
  ]) {
    // The page: the badge on its sidebar entry, the schedule (off), the filters and the projects.
    const page = await openDream(shots, variant);
    await shots.still(page, `page-${theme}.png`);

    // A project's details: why it is not due, and the warning about its memory folder.
    const mobile = page.locator("li").filter({ has: page.getByText("Mobile App", { exact: true }) }).first();
    await mobile.scrollIntoViewIfNeeded();
    await shots.still(page, `project-${theme}.png`, { around: [mobile], pad: 16 });

    // The waiting dry run's changes, file by file.
    await page.getByRole("button", { name: "View changes" }).click();
    await page.getByRole("table", { name: "Changes to build.md" }).waitFor();
    await shots.still(page, `proposal-${theme}.png`);
    await shots.closePage(page);

    // The history, with the newest run opened.
    const history = await openDream(shots, variant);
    await history.getByRole("tab", { name: "History" }).click();
    await history.locator("button[aria-expanded]").filter({ hasText: "Acme Web" }).first().click();
    await history.getByText("Looked at all 9 sessions", { exact: false }).waitFor();
    await shots.still(history, `history-${theme}.png`);
    await shots.closePage(history);

    // The settings: the schedule off by default, Always dry run, the machine and the model.
    // Reached as a user does, from the page's Settings button: loaded directly, bb's settings page never
    // goes network-idle, which the harness waits for.
    // A taller window, so the whole form shows down to the machine and the model.
    const settings = await openDream(shots, { ...variant, viewport: { width: 1280, height: 1640 } });
    await settings.getByRole("button", { name: "Settings", exact: true }).last().click();
    await settings.getByText("Always dry run", { exact: true }).first().waitFor();
    await settings.getByText("Dream machine and model").first().waitFor();
    await settings.getByTestId("dream-saved-model").waitFor();
    await shots.still(settings, `settings-${theme}.png`, {
      around: [settings.getByText("Plugin details").first(), settings.getByText("Always dry run", { exact: true }).first(), settings.locator("#dream-machine"), settings.getByTestId("dream-saved-model")],
      pad: 40,
    });
    await shots.closePage(settings);
  }
}
