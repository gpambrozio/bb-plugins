// Shot list for FirstMate: the board beside the first mate's chat, with suggestions, a crewmate at
// work, held cards with the captain's answer buttons, a failed and a parked crewmate (Notify parent
// off), queued and done work, and the watches; light and dark, on a desktop window and at phone
// width; and a GIF of opening the board and starting an answer. Run with `npm run shots -- firstmate-crew` in tools/shots; it writes into
// firstmate-crew/docs/screenshots/.
//
// The first mate's home is a fixture inside the dev bb's fake HOME: its backlog, suggestions and
// projects are written before the launch, which keeps them (the plugin never overwrites records).
// Its one watch is the built-in pr-watch, replaced by an inert copy that prints nothing and calls
// nothing (the plugin keeps an edited copy as it is), with a last run seeded in its state file. The
// first mate and its crew run on the scripted agent; the crew is dispatched with the plugin's own
// `crew spawn`, run as the first mate's thread (bb's CLI takes the caller's thread from
// BB_THREAD_ID). Nothing is sent from the browser.
import { createHash } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { THREAD_EVENTS, writeTree } from "../../tools/shots/lib/seed.mjs";

const PLUGIN = "firstmate-crew";
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = "Acme Web";
const API = "Acme API";
const DAY = 86_400_000;

/** A date `days` before today, as the backlog writes it. */
const ago = (days) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);

/** The crew: each one's backlog task, brief, and what its scripted turn says. */
const CREW = [
  {
    task: "login-redirect",
    title: "Fix the login redirect",
    project: WEB,
    kind: "ship",
    brief: "Signing in from a deep link lands on the home page instead of the page asked for. Find out why and fix it.",
    reply:
      "The session cookie was written after the redirect, so the dashboard saw no session yet. It is now set first, and a new test signs in from a deep link.\n\nneeds-decision: PR https://github.com/acme/web/pull/42 is green; merge it?",
    tools: [
      { title: "Read src/auth/login.ts", kind: "read" },
      { title: "Edit src/auth/login.ts", kind: "edit" },
      { title: "npm test", kind: "execute" },
    ],
  },
  {
    task: "rate-limit",
    title: "Add rate limiting to the public API",
    project: API,
    kind: "ship",
    brief: "Add rate limiting to the public API: 100 requests a minute per API key, then 429 with Retry-After.",
    reply: "Added the limiter as middleware, with a test for the 429 and its Retry-After header.\n\ndone: PR https://github.com/acme/api/pull/17 ready, CI green",
    tools: [
      { title: "Edit src/middleware/rate-limit.ts", kind: "edit" },
      { title: "npm test", kind: "execute" },
    ],
  },
  {
    task: "nightly-e2e",
    title: "Find why the nightly end-to-end run fails",
    project: WEB,
    kind: "scout",
    brief: "The nightly end-to-end suite has failed three nights running. Find out why; change nothing.",
    reply: "Running the end-to-end suite the way the nightly job does.",
    tools: [{ title: "npm run test:e2e", kind: "execute" }],
    error: "The end-to-end browser ran out of memory.",
  },
  {
    task: "date-library",
    title: "Upgrade the date library to version 4",
    project: WEB,
    kind: "ship",
    brief: "Upgrade the date library to version 4 and fix whatever breaks.",
    reply: "Version 4.0 still formats some time zones wrongly; 4.1 fixes it and is due next week.\n\npaused: waiting for date-fns 4.1, which fixes the time zone bug",
    tools: [{ title: "Read package.json", kind: "read" }],
    // Its Notify parent is set to Off while its turn is held, so its card says so.
    notifyParent: "off",
    waitFor: "date-library",
  },
  {
    task: "dark-mode",
    title: "Add dark mode",
    project: WEB,
    kind: "ship",
    brief: "Add a dark theme to the customer site, following the system setting, with a toggle in the header.",
    reply: "Adding dark colour tokens beside the light ones, then the header toggle.",
    tools: [
      { title: "Read src/styles/tokens.css", kind: "read" },
      { title: "Edit src/styles/tokens.css", kind: "edit" },
    ],
    // Never released: this crewmate is still at work when the board is shot.
    waitFor: "dark-mode-never",
  },
];

const BEARINGS =
  "**Needs your call**\n\n- **web#42**, the login redirect fix, is green: merge it? The card has Merge and Hold.\n- **Analytics store**: Postgres or SQLite?\n\n" +
  "**Landed**\n\n- api#17, rate limiting, is ready for review.\n\n" +
  "**Under way**\n\n- Dark mode is being built. The date library upgrade waits for date-fns 4.1.\n\n" +
  "**Next**\n\n- Full-text search, once rate limiting lands. The nightly run failed on memory; I can rerun it with more.";

export const turns = [
  {
    match: "You are the first mate",
    reply: "Aboard, captain. Two projects on the books, Acme Web and Acme API, both shipping through pull requests. Nothing under way yet. What first?",
    tools: [
      { title: "Read AGENTS.md", kind: "read" },
      { title: "Read data/projects.md", kind: "read" },
      { title: "Read data/backlog.md", kind: "read" },
    ],
  },
  {
    match: "deep links land",
    reply: "Aye. Five crewmates dispatched, one per task, each in its own worktree. The board has them.",
    tools: [
      { title: "Edit data/backlog.md", kind: "edit" },
      ...CREW.map((crew) => ({ title: `bb firstmate-crew crew spawn --task ${crew.task}`, kind: "execute" })),
    ],
    // Held while the seed dispatches the crew, so their outcomes reach the first mate in one notice.
    waitFor: "dispatch",
  },
  { match: "Bearings", reply: BEARINGS, tools: [{ title: "Read data/backlog.md", kind: "read" }] },
  ...CREW.map((crew) => ({ match: escapeRegExp(crew.brief), reply: crew.reply, tools: crew.tools, error: crew.error, waitFor: crew.waitFor })),
  // bb's one notice of the crew's finished turns. They end while the dispatch turn is held, so bb
  // batches them and steers the notice into that turn, whose reply then answers it.
  {
    match: "Child thread updates",
    reply:
      "Three back. **web#42** is green and waits on your word to merge; the board has Merge and Hold. **api#17**, rate limiting, is up for review. The nightly scout's browser ran out of memory: I can rerun it with more, your call.",
    tools: [
      { title: "Read data/backlog.md", kind: "read" },
      { title: "Edit data/backlog.md", kind: "edit" },
      { title: "Edit data/suggestions.md", kind: "edit" },
    ],
  },
];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The first mate's records, as a captain mid-voyage would have them. */
function records() {
  const line = (crew, extra = "") => `- [ ] ${crew.task} - ${crew.title} (project: ${crew.project}) (kind: ${crew.kind})${extra} (since ${ago(1)})`;
  const [login, rate, nightly, dates, dark] = CREW;
  const backlog = `# Backlog

Work items only, one line each. The first mate keeps this file; the FirstMate board reads it.

## In flight
${line(login, " https://github.com/acme/web/pull/42 (mode: reviewed-PR) (hold: captain's word to merge) (actions: Merge => Merge https://github.com/acme/web/pull/42 | Hold => Hold https://github.com/acme/web/pull/42 until Monday)")}
${line(dark, " (mode: reviewed-PR)")}
${line(rate, " https://github.com/acme/api/pull/17 (mode: direct-PR)")}
${line(nightly)}
${line(dates, " (mode: reviewed-PR)")}

## Queued
- [ ] search-api - Add full-text search to the API (project: ${API}) (kind: ship) (blocked-by: rate-limit)
- [ ] analytics-db - Postgres or SQLite for the analytics store? (kind: captain) (hold: Postgres or SQLite) (actions: Postgres => Use Postgres for the analytics store | SQLite => Use SQLite for the analytics store)
- [ ] onboarding-emails - Rewrite the onboarding emails (project: ${WEB}) (kind: ship)

## Done
- [x] signup-captcha - Add a captcha to sign-up https://github.com/acme/web/pull/39 (merged ${ago(4)})
- [x] api-reference - Publish the API reference https://github.com/acme/api/pull/15 (merged ${ago(5)})
- [x] slow-dashboard - Find why the dashboard loads slowly data/slow-dashboard/report.md (done ${ago(7)})
`;
  const suggestions = `# Suggestions

- Land web#42 :: Merge https://github.com/acme/web/pull/42
- Review loop on api#17 :: Run a review loop on https://github.com/acme/api/pull/17 until it comes back clean: fix what it finds, rerun the load test in scripts/load.js, and tell me whether the limits still hold at twice today's peak traffic
- Rerun nightly :: Rerun the nightly end-to-end suite with twice the memory
`;
  const projects = `# Projects

One line per project: \`- <name> [<mode> +yolo] - <path or clone URL> - <description>\`.
Modes: direct-PR, local-only, reviewed-PR. \`+yolo\` lets the first mate merge green work itself.

- Acme-Web [reviewed-PR] - bb project "${WEB}" - The customer site.
- Acme-API [direct-PR] - bb project "${API}" - The public API.
`;
  return { backlog, suggestions, projects };
}

/**
 * The built-in pr-watch, made inert: it prints nothing and runs nothing. It carries the current
 * template's fingerprint line, so the plugin reads it as the captain's edit of the current version
 * (kept as it is, not outdated) and the Watches card draws it as usual.
 */
function inertPrWatch() {
  const template = readFileSync(join(HERE, "..", "templates", "watches", "pr-watch"), "utf8");
  const neutral = template.replace(/\r\n?/g, "\n").replace(/firstmate-watch ([0-9a-f]{16}|\{\{fingerprint\}\})/, "firstmate-watch");
  const fingerprint = createHash("sha256").update(neutral).digest("hex").slice(0, 16);
  return `#!/bin/sh
# schedule: */5 * * * *
# firstmate-watch ${fingerprint} (the FirstMate version this copy started from; leave it as it is)
#
# An inert copy for the screenshot dev bb: it prints nothing and asks nothing of GitHub.
exit 0
`;
}

/** Waits until the first mate has taken every turn bb gave it and stays idle for a moment. */
async function mateSettled(bb, mateId) {
  let quietSince = 0;
  await bb.waitFor(
    "the first mate to settle",
    () => {
      const { thread } = bb.cliJson(["thread", "show", mateId, "--json"]);
      const idle = thread.status === "idle" && !(thread.queuedMessageCount > 0);
      if (!idle) quietSince = 0;
      else quietSince ||= Date.now();
      return idle && Date.now() - quietSince > 2000;
    },
    { timeoutMs: 60_000 },
  );
}

export async function seed({ bb, seed }) {
  const home = join(seed.home, "FirstMate");
  seed.project(WEB, { "README.md": "# Acme Web\n\nThe Acme customer site.\n" });
  seed.project(API, { "README.md": "# Acme API\n\nThe Acme public API.\n" });

  // The home's records and the inert watch, before the launch prepares the rest of it.
  const { backlog, suggestions, projects } = records();
  const briefs = Object.fromEntries(CREW.map((crew) => [`data/${crew.task}/brief.md`, `You are a crewmate.\n\n${crew.brief}\n`]));
  writeTree(home, {
    "data/backlog.md": backlog,
    "data/suggestions.md": suggestions,
    "data/projects.md": projects,
    "watches/pr-watch": inertPrWatch(),
    ".firstmate/watches.json": JSON.stringify({
      watches: { "pr-watch": { lastRunAt: new Date(Date.now() - 3 * 60_000).toISOString(), lastResult: "silent", lastOutput: null, lastOutputAt: null, lastError: null, failing: false } },
      queue: [],
      dropped: 0,
    }),
    ...briefs,
  });
  chmodSync(join(home, "watches", "pr-watch"), 0o755);

  bb.cli(["plugin", "config", PLUGIN, "set", "homeDirectory", home]);
  bb.cli(["plugin", "config", PLUGIN, "set", "crewProvider", "acp-demo"]);
  bb.cli(["plugin", "config", PLUGIN, "set", "crewModel", "demo"]);

  const { threadId: mateId } = seed.rpc(PLUGIN, "mate.launch", { providerId: "acp-demo", model: "demo" });
  await seed.waitForEvent(mateId, THREAD_EVENTS.turnEnded, 1);
  bb.cli(["thread", "tell", mateId, "Deep links land on the home page after signing in, the API needs rate limiting, and dark mode is overdue. The nightly run keeps failing, and the date library wants version 4."]);
  await seed.waitForEvent(mateId, THREAD_EVENTS.turnStarted, 2);

  // The crew, dispatched as the first mate would: through the plugin's `crew spawn`, from its thread.
  for (const crew of CREW) {
    const out = seed.cliAs(mateId, [
      PLUGIN, "crew", "spawn",
      "--task", crew.task,
      "--project", crew.project,
      "--kind", crew.kind,
      "--title", crew.title,
      "--provider", "acp-demo",
      "--model", "demo",
      "--prompt-file", join(home, "data", crew.task, "brief.md"),
      "--json",
    ]);
    const { threadId } = JSON.parse(out);
    if (crew.notifyParent) {
      await seed.waitForEvent(threadId, THREAD_EVENTS.turnStarted, 1);
      bb.cli(["thread", "update", threadId, "--parent-notifications", crew.notifyParent]);
      seed.release(crew.waitFor);
      await seed.waitForEvent(threadId, THREAD_EVENTS.turnEnded, 1);
    } else if (crew.waitFor) {
      // Never released: it stays at work.
      await seed.waitForEvent(threadId, THREAD_EVENTS.turnStarted, 1);
    } else {
      await seed.waitForEvent(threadId, THREAD_EVENTS.turnEnded, 1);
    }
  }
  await bb.waitFor("bb's notice of the crew's turns", () => seed.events(mateId, "client/turn/requested").some((event) => event.data?.systemMessageKind === "child-outcome-batch"));
  seed.release("dispatch");
  await seed.waitForEvent(mateId, THREAD_EVENTS.turnEnded, 2);
  await mateSettled(bb, mateId);
  await seed.send({ threadId: mateId, prompt: "Bearings, please." });
  await mateSettled(bb, mateId);
}

/**
 * The board's section order and folds, which each browser keeps in localStorage (`app/column-order.ts`,
 * `app/folds.ts`): the cards waiting on the captain first, the long Done list folded.
 */
const LAYOUTS = {
  calls: { order: ["blocked", "working", "parked", "failed", "idle", "queued", "done"], folds: ["queued", "done"] },
  crew: { order: ["working", "parked", "failed", "blocked", "idle", "queued", "done"], folds: ["blocked", "queued", "done"] },
};

/** The first mate's thread with the board open in its panel, as the captain opens it: + → FirstMate. */
async function openBoard(shots, variant, mateId, layout) {
  const page = await shots.page(variant, "/");
  await page.evaluate(({ order, folds }) => {
    localStorage.setItem("firstmate.order", JSON.stringify(order));
    localStorage.setItem("firstmate.folds", JSON.stringify(folds));
  }, LAYOUTS[layout]);
  await page.goto(new URL(`/threads/${mateId}`, page.url()).href, { waitUntil: "networkidle" });
  await page.getByText("Needs your call", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Show right panel (⌘ J)" }).click();
  await page.getByRole("button", { name: "Open new tab (⌘ T)" }).click();
  await page.getByText("FirstMate", { exact: true }).last().click();
  await page.getByText("SUGGESTIONS", { exact: false }).first().waitFor();
  // The newest cards to draw: a held card's answer buttons, or a crewmate's status line.
  if (layout === "calls") await page.getByRole("button", { name: /^Merge: send/ }).waitFor();
  else await page.getByText(/Notify parent is Off/).waitFor();
  await page.getByText("pr-watch", { exact: true }).waitFor();
  // Away from every card, so none is drawn hovered.
  await page.mouse.move(2, (variant.viewport.height ?? 800) - 2);
  await page.waitForTimeout(600);
  return page;
}

function mateOf(bb) {
  const listed = bb.cliJson(["thread", "list", "--json"]);
  const mate = (listed.threads ?? listed).find((thread) => thread.title === "First mate");
  if (!mate) throw new Error("no first mate was launched");
  return mate.id;
}

export async function shoot({ bb, shots, VARIANTS }) {
  const mateId = mateOf(bb);
  const wide = (variant) => ({ ...variant, viewport: { width: 1440, height: 960 } });

  // The board beside the first mate's chat: suggestions, then the cards waiting on the captain.
  for (const [variant, file] of [
    [wide(VARIANTS.desktopLight), "board-light.png"],
    [wide(VARIANTS.desktopDark), "board-dark.png"],
  ]) {
    const page = await openBoard(shots, variant, mateId, "calls");
    await shots.still(page, file);
    await shots.closePage(page);
  }

  // The crew's cards: one at work, one parked with Notify parent off, one failed.
  for (const [variant, file] of [
    [wide(VARIANTS.desktopLight), "crew-light.png"],
    [wide(VARIANTS.desktopDark), "crew-dark.png"],
  ]) {
    const page = await openBoard(shots, variant, mateId, "crew");
    const header = (name) => page.getByRole("button", { name: new RegExp(`^${name} \\(\\d+\\)`, "i") }).first();
    const card = (title) => page.getByText(title, { exact: true }).last().locator("xpath=ancestor::div[contains(@class,'border-l-4')][1]");
    await shots.still(page, file, { around: [header("Working"), card("Add dark mode"), card("Upgrade the date library to version 4")], pad: 16 });
    await shots.closePage(page);
  }

  // At phone width the board takes the screen over the chat.
  for (const [variant, file] of [
    [VARIANTS.phoneLight, "board-phone-light.png"],
    [VARIANTS.phoneDark, "board-phone-dark.png"],
  ]) {
    const page = await openBoard(shots, variant, mateId, "calls");
    await shots.still(page, file);
    await shots.closePage(page);
  }

  // The demo: open the board, read a long suggestion whole, and start an answer on a held card. Nothing
  // is sent: the page closes with the answer still typed.
  await shots.video(
    "board-demo",
    { ...VARIANTS.desktopLight, viewport: { width: 1280, height: 800 } },
    async (page) => {
      await page.evaluate(({ order, folds }) => {
        localStorage.setItem("firstmate.order", JSON.stringify(order));
        localStorage.setItem("firstmate.folds", JSON.stringify(folds));
      }, LAYOUTS.calls);
      await page.goto(new URL(`/threads/${mateId}`, page.url()).href, { waitUntil: "networkidle" });
      await page.getByText("Needs your call", { exact: true }).waitFor();
      await page.waitForTimeout(1500);
      await page.getByRole("button", { name: "Show right panel (⌘ J)" }).click();
      await page.waitForTimeout(700);
      await page.getByRole("button", { name: "Open new tab (⌘ T)" }).click();
      await page.waitForTimeout(1000);
      await page.getByText("FirstMate", { exact: true }).last().click();
      await page.getByRole("button", { name: /^Merge: send/ }).waitFor();
      await page.waitForTimeout(1800);
      await page.getByRole("button", { name: "Show the whole suggestion: Review loop on api#17" }).click();
      await page.waitForTimeout(2500);
      await page.getByRole("button", { name: "Hide the whole suggestion: Review loop on api#17" }).click();
      await page.waitForTimeout(800);
      const answer = page.getByRole("textbox", { name: "Answer for login-redirect" });
      await answer.click();
      await answer.pressSequentially("Hold it until the release notes are out", { delay: 55 });
      await page.waitForTimeout(2500);
    },
    { formats: ["gif"] },
  );
}
