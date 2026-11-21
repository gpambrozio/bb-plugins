// Live check for Briefing, on the shots harness's throwaway dev bb (no model tokens, nothing of the
// owner's). Briefing has no screen of its own, so instead of screenshots this list calls the plugin's CLI
// the way Handsfree's run_plugin_command does — `POST /api/v1/plugins/briefing/cli` with `{ argv }`, with
// and without a thread on screen — checks what comes back, and saves the outputs as text files.
//
//   cd tools/shots && npm run shots -- briefing --out "$TMPDIR/briefing-live"
//
// The seed: two projects (one described by AGENTS.md after the boilerplate line, one whose CLAUDE.md only
// imports AGENTS.md, whose AGENTS.md is a symlink to a file outside the checkout that must never be read,
// and whose README describes it), root threads that are finished, failed, waiting on a
// permission, and archived, twenty more to press on the size budget, and a FirstMate home with a backlog
// (holds, blocked-by, in flight, queued, done) whose first mate runs two crewmates: one that needs a
// decision and one that is blocked. firstmate-crew is installed from this repository.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { THREAD_EVENTS, writeTree } from "../../tools/shots/lib/seed.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIRSTMATE = join(HERE, "..", "..", "firstmate-crew");
const WEB = "Acme Web";
const API = "Acme API";
/** Handsfree cuts every tool result here. */
const HANDSFREE_LIMIT = 4_000;
const FILLERS = 20;
/** The text of a file outside a checkout that a description symlink points to. */
const OUTSIDE_SENTINEL = "Outside-the-checkout private text";

const CREW = [
  {
    task: "login-redirect",
    title: "Fix the login redirect",
    brief: "Signing in from a deep link lands on the home page. Find out why and fix it.",
    reply: "The session cookie was written after the redirect. It is now set first, with a test.\n\nneeds-decision: PR https://github.com/acme/web/pull/42 is green; merge it?",
  },
  {
    task: "payments-sandbox",
    title: "Wire the payments sandbox",
    brief: "Wire the payments provider's sandbox into the API's checkout flow.",
    reply: "The checkout flow is ready for the sandbox.\n\nblocked: the sandbox API key is not in the secrets store",
  },
];

export const turns = [
  { match: "You are the first mate", reply: "Aboard, captain. Two crewmates are out: the login redirect and the payments sandbox.", waitFor: "dispatch" },
  { match: "Child thread updates", reply: "Captain, the login fix is green and waits on your word to merge. The payments sandbox is blocked on an API key." },
  { match: "What needs me", reply: "Captain, two things need you: merging the login fix, and the analytics database choice." },
  ...CREW.map((crew) => ({ match: crew.brief, reply: crew.reply })),
  { match: "Write the release notes", reply: "I drafted the release notes for 2.4 in CHANGELOG.md. The migration step is called out first." },
  { match: "Also mention the new rate limits", reply: "Added the rate limits to the notes, with the numbers per plan." },
  { match: "Clean the build folder", reply: "Cleaning it now.", permission: { title: "rm -rf build", kind: "execute", command: "rm -rf build" } },
  { match: "Profile the search endpoint", reply: "Profiling the search endpoint.", error: "The profiler could not attach to the process." },
  { match: "Old spike", reply: "Spike done." },
  { match: "Filler task", reply: "Finished this filler task. It went as planned, with nothing left to do. A third sentence for the budget." },
];

function records() {
  const backlog = `# Backlog

## In flight
- [ ] login-redirect - Fix the login redirect (project: ${WEB}) (kind: ship) https://github.com/acme/web/pull/42 (since 2026-11-19)
- [ ] payments-sandbox - Wire the payments sandbox (project: ${API}) (kind: ship) (since 2026-11-19)

## Queued
- [ ] analytics-db - Postgres or SQLite for the analytics store? (kind: captain) (hold: Postgres or SQLite) (actions: Postgres => Use Postgres | SQLite => Use SQLite)
- [ ] search-api - Add full-text search to the API (project: ${API}) (blocked-by: payments-sandbox)
- [ ] onboarding-emails - Rewrite the onboarding emails (project: ${WEB}) (kind: ship) (note: tone like the 2024 ones)

## Done
- [x] signup-captcha - Add a captcha to sign-up https://github.com/acme/web/pull/39 (merged 2026-11-18)
- [x] api-reference - Publish the API reference https://github.com/acme/api/pull/15 (merged 2026-11-17)
`;
  const suggestions = "# Suggestions\n\n- Land the login fix :: Merge https://github.com/acme/web/pull/42\n- Pick the analytics store :: Use Postgres for the analytics store\n";
  return { backlog, suggestions };
}

/** Handsfree's run_plugin_command, against the dev bb. */
async function handsfreeCall(bb, argv, onScreen = null) {
  const response = await fetch(`${bb.cfg.url}/api/v1/plugins/briefing/cli`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ argv, ...(onScreen === null ? {} : { threadId: onScreen.threadId, projectId: onScreen.projectId }) }),
  });
  const result = await response.json();
  if (!response.ok || result.exitCode !== 0) throw new Error(`bb briefing ${argv.join(" ")}: HTTP ${response.status} ${JSON.stringify(result).slice(0, 500)}`);
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function expect(condition, what) {
  if (!condition) throw new Error(`live check failed: ${what}`);
}

const state = {};

export async function seed({ bb, seed }) {
  if (!existsSync(join(FIRSTMATE, "node_modules"))) {
    execFileSync("npm", ["ci", "--no-audit", "--no-fund", "--cache", join(tmpdir(), "bbss-npm-cache")], { cwd: FIRSTMATE, stdio: "inherit" });
  }
  seed.installPlugin(FIRSTMATE);

  const web = seed.project(WEB, {
    "AGENTS.md": "# AGENTS.md\n\nThis file provides guidance to coding agents working in this repository.\n\nAcme Web is the customer site: sign-up, sign-in and the dashboard. It ships through reviewed pull requests.\n\n## Commands\n\n`npm test`\n",
  });
  const api = seed.project(API, { "CLAUDE.md": "@AGENTS.md\n", "README.md": "# Acme API\n\n[![CI](https://ci.example/badge.svg)](https://ci.example)\n\nThe public Acme API, with keys per customer and rate limits per plan.\n" });
  state.web = web;
  // A description file that points outside the checkout: bb must refuse it, and the README describe the project.
  const outside = join(bb.cfg.root, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "private-notes.md"), `# Notes\n\n${OUTSIDE_SENTINEL} must never be read aloud.\n`);
  symlinkSync(join(outside, "private-notes.md"), join(api.path, "AGENTS.md"));

  const home = join(seed.home, "Voyage");
  const { backlog, suggestions } = records();
  writeTree(home, {
    "data/backlog.md": backlog,
    "data/suggestions.md": suggestions,
    "data/projects.md": `# Projects\n\n- Acme-Web [reviewed-PR] - bb project "${WEB}" - The customer site.\n- Acme-API [direct-PR] - bb project "${API}" - The public API.\n`,
    ...Object.fromEntries(CREW.map((crew) => [`data/${crew.task}/brief.md`, `You are a crewmate.\n\n${crew.brief}\n`])),
  });
  bb.cli(["plugin", "config", "firstmate-crew", "set", "homeDirectory", home]);

  // The first mate and its crew, dispatched through firstmate-crew's own `crew spawn` from its thread.
  const { threadId: mateId } = seed.rpc("firstmate-crew", "mate.launch", { providerId: "acp-demo", model: "demo" });
  await seed.waitForEvent(mateId, THREAD_EVENTS.turnStarted, 1);
  state.crew = [];
  for (const crew of CREW) {
    const out = seed.cliAs(mateId, [
      "firstmate-crew", "crew", "spawn",
      "--task", crew.task,
      "--project", crew === CREW[0] ? WEB : API,
      "--title", crew.title,
      "--provider", "acp-demo",
      "--model", "demo",
      "--prompt-file", join(home, "data", crew.task, "brief.md"),
      "--json",
    ]);
    const { threadId } = JSON.parse(out);
    state.crew.push(threadId);
    await seed.waitForEvent(threadId, THREAD_EVENTS.turnEnded, 1);
  }
  seed.release("dispatch");
  await seed.waitForEvent(mateId, THREAD_EVENTS.turnEnded, 1);
  await bb.waitFor("the first mate to take the crew's notice", () => bb.cliJson(["thread", "show", mateId, "--json"]).thread.status === "idle", { timeoutMs: 60_000 });
  await seed.send({ threadId: mateId, prompt: "What needs me?" });
  state.mateId = mateId;

  // Root threads of every kind.
  const notes = await seed.thread({ projectId: api.id, title: "Release notes for 2.4", prompt: "Write the release notes for 2.4 from the merged pull requests." });
  await seed.send({ threadId: notes.id, prompt: "Also mention the new rate limits." });
  state.notes = notes.id;
  const asks = await seed.thread({ projectId: web.id, title: "Clean the build folder", prompt: "Clean the build folder before the next deploy.", until: THREAD_EVENTS.interaction, permissionMode: "accept-edits" });
  state.asks = asks.id;
  const failed = await seed.thread({ projectId: api.id, title: "Profile search", prompt: "Profile the search endpoint under load." });
  state.failed = failed.id;
  const archived = await seed.thread({ projectId: web.id, title: "Old spike", prompt: "Old spike on a new router." });
  bb.cli(["thread", "archive", archived.id]);
  state.archived = archived.id;
  for (let index = 0; index < FILLERS; index++) {
    await seed.thread({
      projectId: index % 2 === 0 ? web.id : api.id,
      title: `Filler thread ${index}`,
      prompt: `Filler task ${index}: a long opening message that goes on for a while to press on the briefing's size budget, with more words than a voice needs to hear at the start of a session.`,
    });
  }
}

/** Every thread's event count, to prove the briefing wrote nothing. */
function eventCounts(bb) {
  const threads = bb.cliJson(["thread", "list", "--include-archived", "--include-hidden", "--json"]);
  return Object.fromEntries(threads.map((thread) => [thread.id, bb.cliJson(["thread", "log", thread.id, "--json", "--all"]).length]));
}

export async function shoot({ bb, shots }) {
  const before = eventCounts(bb);
  const started = Date.now();
  const text = await handsfreeCall(bb, []);
  const took = Date.now() - started;
  const onScreen = await handsfreeCall(bb, [], { threadId: state.notes, projectId: state.web.id });
  const json = JSON.parse(await handsfreeCall(bb, ["--json"]));
  const mate = await handsfreeCall(bb, ["thread", state.mateId]);
  const notes = await handsfreeCall(bb, ["thread", state.notes]);
  const help = await handsfreeCall(bb, ["--help"]);

  expect(text.length <= HANDSFREE_LIMIT, `the briefing is ${text.length} characters`);
  expect(mate.length <= HANDSFREE_LIMIT && notes.length <= HANDSFREE_LIMIT, "a thread detail is over the limit");
  expect(text === onScreen, "the briefing changes with the thread on screen");
  expect(!text.includes(state.archived) && !json.threads.some((thread) => thread.id === state.archived), "the archived thread is in the briefing");
  expect(!json.threads.some((thread) => state.crew.includes(thread.id)), "a crewmate is briefed as a root thread");
  expect(json.threads.length === 4 + FILLERS, `${json.threads.length} root threads`);
  const fm = json.firstMate;
  expect(fm !== null && fm.threadId === state.mateId, "no FirstMate section");
  expect(fm.needsOwner.some((line) => /analytics/i.test(line.title)), "the held analytics choice is not under needs you");
  expect(fm.blocked.some((line) => /search/i.test(line.title) && line.detail === "waits on another task"), "the blocked-by task is not blocked");
  expect(fm.blocked.some((line) => /login/i.test(line.title) && line.detail === "worker needs a decision"), "the needs-decision worker is not blocked");
  expect(fm.blocked.some((line) => /payments/i.test(line.title) && line.detail === "worker is blocked"), "the blocked worker is not blocked");
  expect(fm.queued.some((line) => /onboarding/i.test(line.title)) && fm.done.length === 2, "queued or done are wrong");
  expect(fm.suggestions.length === 2, "the suggestions are missing");
  const mateBrief = json.threads.find((thread) => thread.id === state.mateId);
  expect(mateBrief.childCount === 2 && mateBrief.flaggedChildren.length === 2, "the crew is not counted under the first mate");
  expect(mateBrief.lastUser === "What needs me?", `the first mate's latest user message is ${JSON.stringify(mateBrief.lastUser)}`);
  const notesBrief = json.threads.find((thread) => thread.id === state.notes);
  expect(notesBrief.opening.startsWith("Write the release notes") && notesBrief.lastUser === "Also mention the new rate limits.", "the opening or latest user message is wrong");
  expect(json.threads[0].id === state.asks && json.threads[0].needsUser, "the thread waiting on the user is not first");
  expect(json.threads.find((thread) => thread.id === state.failed).status === "failed", "the failed thread is not failed");
  const descriptions = Object.fromEntries(json.projects.map((project) => [project.name, project]));
  expect(descriptions[WEB].description.startsWith("Acme Web is the customer site") && descriptions[WEB].source === "AGENTS.md", "Acme Web's description");
  expect(descriptions[API].description.startsWith("The public Acme API") && descriptions[API].source === "README.md", "Acme API's description");
  for (const [name, output] of Object.entries({ text, json: JSON.stringify(json), mate, notes })) {
    expect(!output.includes(OUTSIDE_SENTINEL), `the ${name} output read a file outside a checkout`);
  }
  expect(descriptions.FirstMate.source === "FirstMate", "the first mate's home is described from its charter");
  expect(mate.includes("FirstMate's tasks:") && mate.includes("Sub-threads (2):"), "the first mate's detail");
  expect(JSON.stringify(eventCounts(bb)) === JSON.stringify(before), "a thread's event log changed during the briefing");

  const out = join(bb.cfg.root, "out");
  const files = {
    "briefing.txt": `${text}\n\n(${text.length} characters, ${took} ms)\n`,
    "briefing.json": `${JSON.stringify(json, null, 2)}\n`,
    "thread-firstmate.txt": `${mate}\n\n(${mate.length} characters)\n`,
    "thread-notes.txt": `${notes}\n\n(${notes.length} characters)\n`,
    "help.txt": `${help}\n`,
  };
  for (const [name, content] of Object.entries(files)) {
    const path = join(out, name);
    writeFileSync(path, content);
    shots.files.push(path);
  }
  console.log(`briefing: ${text.length} characters in ${took} ms; thread details ${mate.length} and ${notes.length}`);
}
