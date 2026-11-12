// Shot list for Learning Exercises: the offer above the composer after a commit, a question card with
// an answer form and the feedback on the answer before it, the Learning tab with the session in
// progress, the Orientation section, the walkthrough tab and the export dialog; light and dark, on a
// desktop window and at phone width where the surface has one; and a GIF from the Orientation section
// through the walkthrough. Run with `npm run shots -- learning-exercises`
// in tools/shots; it writes into learning-exercises/docs/screenshots/.
//
// Everything goes through the plugin's own code: the scripted agent gets no plugin tools and runs
// nothing, so its turns are held (`waitFor`) while the seed does what the agent would through
// `bb learning …`, run as that thread (the commands take their caller's thread from BB_THREAD_ID).
// - The offer: a turn in "Acme API" is held while the seed commits in its worktree, so the plugin finds
//   the commit at the turn's end and makes its offer, as for any agent's commit.
// - The orientation: started over RPC from that thread; its hidden builder's turn is held while the
//   seed records chapters, notes, listings (captured by the plugin from the fixture's files) and the
//   summary with `bb learning orient …`, then finishes it.
// - The session: started over RPC in a thread of "Acme Web" (the scripted provider cannot fork, so it
//   runs there); question 1 is asked with `bb learning ask`, answered with `bb thread interactions
//   respond`, and question 2, an answer form, follows the feedback on it.
// The export dialog is opened and closed; nothing is exported. Nothing is sent from the browser.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { THREAD_EVENTS } from "../../tools/shots/lib/seed.mjs";

const PLUGIN = "learning-exercises";
const API = "Acme API";
const WEB = "Acme Web";
/** The thread that commits, named after its commit's subject. */
const RETRY = "Retry requests after a rate limit";
const TIMEOUT = "Expire idle sessions";

// ---------------------------------------------------------------------------------------------------
// Fixture repositories
// ---------------------------------------------------------------------------------------------------

const API_FILES = {
  "package.json": JSON.stringify({ name: "acme-api", private: true, type: "module", scripts: { start: "node dist/server.js", test: "vitest run" } }, null, 2) + "\n",
  "README.md": "# Acme API\n\nThe Acme public API: orders, customers and webhooks, over HTTP and JSON.\n",
  "src/config.ts": `export interface Config {
  port: number;
  databaseUrl: string;
  /** Requests a key may make per minute before it gets 429. */
  requestsPerMinute: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8080),
    databaseUrl: env.DATABASE_URL ?? "postgres://localhost/acme",
    requestsPerMinute: Number(env.REQUESTS_PER_MINUTE ?? 100),
  };
}
`,
  "src/server.ts": `import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { ordersRoute } from "./routes/orders.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const limit = rateLimit({ perMinute: config.requestsPerMinute });

// Every request passes the limiter first, then reaches its route.
createServer(async (req, res) => {
  if (!limit(req, res)) return;
  if (req.url?.startsWith("/orders")) return ordersRoute(pool, req, res);
  res.writeHead(404).end();
}).listen(config.port);
`,
  "src/middleware/rate-limit.ts": `import type { IncomingMessage, ServerResponse } from "node:http";

interface Bucket {
  tokens: number;
  refilledAt: number;
}

/** A token bucket per API key: \`perMinute\` requests, refilled continuously. */
export function rateLimit({ perMinute, now = Date.now }: { perMinute: number; now?: () => number }) {
  const buckets = new Map<string, Bucket>();
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const key = String(req.headers["x-api-key"] ?? "anonymous");
    const bucket = buckets.get(key) ?? { tokens: perMinute, refilledAt: now() };
    const elapsed = now() - bucket.refilledAt;
    bucket.tokens = Math.min(perMinute, bucket.tokens + (elapsed / 60_000) * perMinute);
    bucket.refilledAt = now();
    buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    const wait = Math.ceil(((1 - bucket.tokens) / perMinute) * 60);
    res.writeHead(429, { "Retry-After": String(wait) }).end();
    return false;
  };
}
`,
  "src/routes/orders.ts": `import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "../db/pool.js";

export async function ordersRoute(pool: Pool, req: IncomingMessage, res: ServerResponse) {
  const rows = await pool.query("select id, total, status from orders order by created_at desc limit 50");
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rows));
}
`,
  "src/db/pool.ts": `export interface Pool {
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
}

/** One pool per process; every route shares it. */
export function createPool(url: string): Pool {
  return {
    async query(sql, params = []) {
      void url;
      void sql;
      void params;
      return [];
    },
  };
}
`,
  "test/rate-limit.test.ts": `import { expect, test } from "vitest";
import { rateLimit } from "../src/middleware/rate-limit.js";

test("the 101st request in a minute gets 429", () => {
  let t = 0;
  const limit = rateLimit({ perMinute: 100, now: () => t });
  const res = { writeHead: () => ({ end() {} }) } as never;
  const req = { headers: { "x-api-key": "k" } } as never;
  for (let i = 0; i < 100; i++) expect(limit(req, res)).toBe(true);
  expect(limit(req, res)).toBe(false);
});
`,
};

/** What thread A's turn commits: a client helper that waits out a 429 before trying again. */
const RETRY_FILE = `/** Calls \`send\` again after a 429, waiting as long as Retry-After says, at most \`attempts\` times. */
export async function withRetry(send: () => Promise<Response>, { attempts = 3, sleep = wait } = {}): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const response = await send();
    if (response.status !== 429 || attempt >= attempts) return response;
    const seconds = Number(response.headers.get("retry-after") ?? 1);
    await sleep(Math.min(seconds, 30) * 1000);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
`;

const WEB_FILES = {
  "package.json": JSON.stringify({ name: "acme-web", private: true, type: "module" }, null, 2) + "\n",
  "README.md": "# Acme Web\n\nThe Acme customer site.\n",
  "src/session.ts": `export interface Session {
  userId: string;
  createdAt: number;
  lastSeenAt: number;
}

/** Signed out after 30 idle minutes, and after 12 hours whatever happens. */
export const IDLE_LIMIT_MS = 30 * 60_000;
export const ABSOLUTE_LIMIT_MS = 12 * 60 * 60_000;

export function isExpired(session: Session, now: number): boolean {
  if (now - session.createdAt > ABSOLUTE_LIMIT_MS) return true;
  return now - session.lastSeenAt > IDLE_LIMIT_MS;
}

/** Every request that finds a live session moves its idle clock on. */
export function touch(session: Session, now: number): Session | null {
  if (isExpired(session, now)) return null;
  return { ...session, lastSeenAt: now };
}
`,
  "src/auth/login.ts": `import { touch, type Session } from "../session.js";

export function currentUser(session: Session | null, now = Date.now()): string | null {
  const live = session === null ? null : touch(session, now);
  return live?.userId ?? null;
}
`,
};

/**
 * The 1-based line range from the first line holding `from` to the next holding `to`, plus `after`
 * lines (a closing brace), in `text`.
 */
function range(text, from, to = from, after = 0) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.includes(from)) + 1;
  const end = lines.findIndex((line, i) => i >= start - 1 && line.includes(to)) + 1 + after;
  if (start < 1 || end < start || end > lines.length) throw new Error(`no lines "${from}"…"${to}" in the fixture`);
  return `${start}-${end}`;
}

// ---------------------------------------------------------------------------------------------------
// The orientation the builder records
// ---------------------------------------------------------------------------------------------------

const SUMMARY = {
  purpose: "The Acme public API: orders over HTTP and JSON, behind a per-key rate limit, with a client helper that retries after a 429.",
  languages: ["TypeScript"],
  stages: [
    "A request reaches the Node HTTP server in src/server.ts.",
    "The rate limiter spends one token from the caller's bucket, or answers 429 with Retry-After.",
    "The route reads from the shared database pool and answers JSON.",
  ],
  keyFiles: [
    { path: "src/server.ts", does: "Wires the config, the pool, the limiter and the routes into one HTTP server.", why: "Read it first: it is the whole request path in fifteen lines." },
    { path: "src/middleware/rate-limit.ts", does: "A token bucket per API key, refilled continuously.", why: "Every request passes it; its arithmetic decides who gets 429." },
    { path: "src/retry.ts", does: "Calls a request again after a 429, waiting as Retry-After says.", why: "The client side of the limit, and the newest code." },
    { path: "src/config.ts", does: "Reads the port, the database URL and the limit from the environment.", why: "The limit's default, 100 a minute, lives here." },
    { path: "src/routes/orders.ts", does: "Lists the newest orders as JSON.", why: "The shape every route follows." },
    { path: "src/db/pool.ts", does: "The database pool every route shares.", why: "One per process; routes never open their own." },
    { path: "test/rate-limit.test.ts", does: "Checks the 101st request in a minute gets 429.", why: "Shows how to drive the limiter with a fake clock." },
  ],
  concepts: [
    { name: "Token bucket", definition: "Each key holds up to N tokens, refilled at N a minute; a request spends one.", where: "src/middleware/rate-limit.ts" },
    { name: "Retry-After", definition: "The seconds a 429 tells the caller to wait before trying again.", where: "src/middleware/rate-limit.ts" },
    { name: "Bounded retry", definition: "Trying again a fixed number of times, never waiting longer than a cap.", where: "src/retry.ts" },
  ],
  gotchas: [
    "Buckets live in process memory: two server processes each allow the full limit.",
    "A request with no API key shares the one anonymous bucket with every other.",
  ],
  exercises: [
    { file: "src/middleware/rate-limit.ts", read: "the refill and the 429 branch", question: "After 30 idle seconds with an empty bucket, how many requests pass at once, and why?" },
    { file: "src/retry.ts", read: "the loop in withRetry", question: "A server answers Retry-After: 120 three times. How long does withRetry wait in all, and what does it return?" },
  ],
  sources: ["src/server.ts", "src/middleware/rate-limit.ts", "src/retry.ts", "src/config.ts", "src/routes/orders.ts", "src/db/pool.ts", "test/rate-limit.test.ts", "README.md"],
};

/** The walkthrough, block by block: [command, …arguments] for `bb learning orient`. */
function walkthrough() {
  const limiter = API_FILES["src/middleware/rate-limit.ts"];
  return [
    ["chapter", "How a request flows"],
    ["note", "Everything starts in `src/server.ts`. Each request passes the rate limiter first and only then reaches its route, so a caller over its limit never touches the database. Listing 1 is the whole path."],
    ["listing", "src/server.ts", range(API_FILES["src/server.ts"], "const config", "listen("), "The server: config, pool, limiter, routes"],
    ["note", "Routes share one database pool, created once per process in `src/db/pool.ts`."],
    ["chapter", "The rate limit"],
    ["note", "The limiter keeps a token bucket per API key. Listing 2 refills it by the time since the last request, then spends one token or answers 429 with a `Retry-After` header."],
    ["listing", "src/middleware/rate-limit.ts", range(limiter, "const key =", "return false;"), "Refill, spend, or refuse"],
    ["note", "Buckets live in this process's memory, so two server processes each allow the full limit. That is fine for one instance and wrong behind a load balancer."],
    ["chapter", "Retrying on the client"],
    ["note", "The newest code is the other side of the limit: `withRetry` in Listing 3 waits as long as `Retry-After` says and tries again, at most three times and never more than 30 seconds a wait."],
    ["listing", "src/retry.ts", range(RETRY_FILE, "export async function withRetry", "await sleep", 2), "Wait, then try again"],
  ];
}

// ---------------------------------------------------------------------------------------------------
// The session's questions
// ---------------------------------------------------------------------------------------------------

const Q1 = `Open \`src/session.ts\` and read \`isExpired\`.

A user signed in at 09:00 and has clicked something every ten minutes since. Predict what \`isExpired\` returns at **20:55** and at **21:05**, and say which limit decides each.`;

const A1 = "False at 20:55: they were seen ten minutes ago, so the idle limit has not run out. True at 21:05, because 12 hours since 09:00 have passed.";

const FEEDBACK1 = `**Right on both.** At 20:55 the idle check passes, and at 21:05 the absolute limit wins: 12 hours after 09:00 is 21:00, whatever the clicks.

One thing to add: the order matters. \`isExpired\` checks the absolute limit **first**, so a busy user is signed out at 21:00 on the dot, not at their next idle gap.`;

const Q2 = `Now \`touch\` in \`src/session.ts\`, which every request calls.

For each request below, from a session created at 09:00 and last seen at 09:40, say whether \`touch\` keeps the session or returns \`null\`, and what \`lastSeenAt\` becomes.`;

const FORM2 = {
  items: [
    {
      kind: "table",
      id: "requests",
      label: "What does touch do?",
      columns: [
        { id: "result", label: "Result", control: "choice", options: [{ value: "kept", label: "Kept" }, { value: "null", label: "null" }] },
        { id: "seen", label: "lastSeenAt becomes", control: "text", placeholder: "a time, or unchanged" },
      ],
      rows: [
        { id: "at0955", label: "A request at 09:55" },
        { id: "at1015", label: "A request at 10:15" },
        { id: "at2130", label: "A request at 21:30" },
      ],
    },
    { kind: "long-text", id: "why", label: "Why does the 10:15 request get that answer?", rows: 3 },
  ],
};

// ---------------------------------------------------------------------------------------------------
// The scripted turns
// ---------------------------------------------------------------------------------------------------

export const turns = [
  {
    match: "retry after a 429",
    reply: `Added \`withRetry\` in \`src/retry.ts\`: it waits as long as \`Retry-After\` says, caps each wait at 30 seconds, and gives up after three attempts. Committed as "${RETRY}".`,
    tools: [
      { title: "Read src/middleware/rate-limit.ts", kind: "read" },
      { title: "Edit src/retry.ts", kind: "edit" },
      { title: `git commit -m "${RETRY}"`, kind: "execute" },
    ],
    // Held while the seed makes the commit, so it lands inside this turn.
    waitFor: "commit",
  },
  {
    match: "idle sessions",
    reply: "Sessions now end after 30 idle minutes and after 12 hours whatever happens; `touch` moves the idle clock on each request.",
    tools: [{ title: "Edit src/session.ts", kind: "edit" }],
  },
  {
    match: "Building an orientation for",
    reply: "Reading the repository and recording the orientation.",
    tools: [
      { title: "Read README.md", kind: "read" },
      { title: "Read src/server.ts", kind: "read" },
      { title: "Read src/middleware/rate-limit.ts", kind: "read" },
    ],
    waitFor: "orientation",
  },
  { match: "Learning exercise on", reply: "I've asked the first question.", tools: [{ title: "bb learning ask --type prediction", kind: "execute" }], waitFor: "question-1" },
  {
    match: "Give direct feedback now",
    reply: "I've asked the next question.",
    tools: [
      { title: "bb learning feedback --verdict correct", kind: "execute" },
      { title: "bb learning ask --type trace", kind: "execute" },
    ],
    waitFor: "question-2",
  },
];

// ---------------------------------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------------------------------

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

/** The folder a thread works in. */
function workspaceOf(bb, threadId) {
  const { thread } = bb.cliJson(["thread", "show", threadId, "--json"]);
  const environment = bb.cliJson(["environment", "show", thread.environmentId, "--json"]);
  const path = environment.environment?.path ?? environment.path;
  if (!path) throw new Error(`no workspace for ${threadId}`);
  return path;
}

function git(cwd, ...args) {
  execFileSync("git", ["-C", cwd, "-c", "user.name=Demo", "-c", "user.email=demo@example.com", ...args], { stdio: "ignore" });
}

async function seedOffer(bb, seed, projectId) {
  const thread = await seed.thread({ projectId, title: RETRY, prompt: "Retry after a 429 in the API client, waiting as long as Retry-After says", until: THREAD_EVENTS.turnStarted });
  const cwd = workspaceOf(bb, thread.id);
  writeFileSync(`${cwd}/src/retry.ts`, RETRY_FILE);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", RETRY);
  seed.release("commit");
  await seed.waitForEvent(thread.id, THREAD_EVENTS.turnEnded, 1);
  await bb.waitFor("the commit offer", () => seed.rpc(PLUGIN, "threadView", { threadId: thread.id }).offer != null);
  return thread.id;
}

async function seedOrientation(bb, seed, sourceId) {
  const { orientationId } = seed.rpc(PLUGIN, "startOrientation", { threadId: sourceId, depth: "walkthrough" });
  let builder = null;
  await bb.waitFor("the orientation builder's turn", () => {
    const listed = bb.cliJson(["thread", "list", "--json", "--include-hidden"]);
    builder = (listed.threads ?? listed).find((thread) => thread.title === `Orientation builder: ${API}`);
    return builder && seed.events(builder.id, THREAD_EVENTS.turnStarted).length > 0;
  });
  const orient = (...args) => seed.cliAs(builder.id, ["learning", "orient", ...args]);
  for (const [kind, ...args] of walkthrough()) {
    if (kind === "chapter") orient("chapter", "--title-base64", b64(args[0]));
    if (kind === "note") orient("note", "--markdown-base64", b64(args[0]));
    if (kind === "listing") orient("listing", "--path", args[0], "--lines", args[1], "--caption-base64", b64(args[2]));
  }
  orient("summary", "--summary-base64", b64(JSON.stringify(SUMMARY)));
  orient("finish");
  seed.release("orientation");
  await bb.waitFor("the orientation to be ready", () => seed.rpc(PLUGIN, "orientation", { threadId: sourceId }).current?.status === "ready");
  return orientationId;
}

async function seedSession(bb, seed, projectId) {
  const thread = await seed.thread({ projectId, title: TIMEOUT, prompt: "Expire idle sessions after 30 minutes, and every session after 12 hours" });
  seed.rpc(PLUGIN, "startSession", { threadId: thread.id, topic: "`isExpired` and `touch` in `src/session.ts`", trigger: "manual", refs: { paths: ["src/session.ts"] }, here: true });
  await seed.waitForEvent(thread.id, THREAD_EVENTS.turnStarted, 2);
  const session = WEB_FILES["src/session.ts"];
  seed.cliAs(thread.id, ["learning", "ask", "--type", "prediction", "--question-base64", b64(Q1), "--file", `src/session.ts:${range(session, "export function isExpired", "return now - session.lastSeenAt", 1)}`]);
  seed.release("question-1");
  await seed.waitForEvent(thread.id, THREAD_EVENTS.turnEnded, 2);

  // The learner's answer, as the card would send it.
  const pending = () => {
    const listed = bb.cliJson(["thread", "interactions", "list", thread.id, "--json"]);
    return (listed.interactions ?? listed).find((interaction) => interaction.status === "pending");
  };
  await bb.waitFor("question 1's card", () => pending());
  bb.cli(["thread", "interactions", "respond", pending().id, thread.id, "--value", JSON.stringify({ action: "answer", answer: A1, confidence: 4 })]);
  await seed.waitForEvent(thread.id, THREAD_EVENTS.turnStarted, 3);
  seed.cliAs(thread.id, ["learning", "feedback", "--verdict", "correct", "--feedback-base64", b64(FEEDBACK1), "--concept", "absolute session limit"]);
  seed.cliAs(thread.id, ["learning", "ask", "--type", "trace", "--question-base64", b64(Q2), "--file", `src/session.ts:${range(session, "export function touch", "return { ...session", 1)}`, "--form-base64", b64(JSON.stringify(FORM2))]);
  seed.release("question-2");
  await seed.waitForEvent(thread.id, THREAD_EVENTS.turnEnded, 3);
  await bb.waitFor("question 2's card", () => pending());
  return thread.id;
}

export async function seed({ bb, seed }) {
  const api = seed.project(API, API_FILES);
  const web = seed.project(WEB, WEB_FILES);
  const offerThread = await seedOffer(bb, seed, api.id);
  await seedOrientation(bb, seed, offerThread);
  await seedSession(bb, seed, web.id);
}

// ---------------------------------------------------------------------------------------------------
// Shooting
// ---------------------------------------------------------------------------------------------------

function threadId(bb, title) {
  const listed = bb.cliJson(["thread", "list", "--json"]);
  const thread = (listed.threads ?? listed).find((candidate) => candidate.title === title);
  if (!thread) throw new Error(`no "${title}" thread was seeded`);
  return thread.id;
}

const wide = (variant, height = 960) => ({ ...variant, viewport: { width: 1440, height } });
const pairs = (VARIANTS, base, { phone = false, size } = {}) => [
  [size ? size(VARIANTS.desktopLight) : VARIANTS.desktopLight, `${base}-light.png`],
  [size ? size(VARIANTS.desktopDark) : VARIANTS.desktopDark, `${base}-dark.png`],
  ...(phone
    ? [
        [VARIANTS.phoneLight, `${base}-phone-light.png`],
        [VARIANTS.phoneDark, `${base}-phone-dark.png`],
      ]
    : []),
];

async function openThread(shots, variant, id, ready) {
  const page = await shots.page(variant, `/threads/${id}`);
  await ready(page);
  return page;
}

/** Opens the side panel's Learning tab. */
async function openLearningTab(page) {
  await page.getByRole("button", { name: "Show right panel (⌘ J)" }).click();
  await page.getByRole("button", { name: "Show learning panel" }).click();
}

const offerReady = (page) => page.getByRole("button", { name: "Not in this thread" }).first().waitFor();
const cardReady = (page) => page.getByText("Requested by Learning Exercises", { exact: true }).waitFor();
/** The question card: bb's form section around this plugin's card. */
const questionCard = (page) => page.getByText("Requested by Learning Exercises", { exact: true }).locator("xpath=ancestor::section[1]");

/** The walkthrough tab's chapter picker. */
const chapterPicker = (page) => page.locator("select").filter({ has: page.locator("option", { hasText: "The rate limit" }) });

/**
 * Scrolls the question card's own scroll area (bb caps it at 32rem) to its end, where the form, the
 * confidence and the buttons are, then back to the start of the paragraph its top edge cuts, so no
 * half line shows.
 */
async function cardToForm(page) {
  await questionCard(page).evaluate((section) => {
    const area = [...section.querySelectorAll("*")].find((el) => el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY === "auto");
    if (!area) throw new Error("the question card has no scroll area");
    area.scrollTop = area.scrollHeight;
    const top = area.getBoundingClientRect().top;
    const cut = [...area.querySelectorAll("p")].find((p) => {
      const box = p.getBoundingClientRect();
      return box.top < top && box.bottom > top;
    });
    if (cut) area.scrollTop -= top - cut.getBoundingClientRect().top + 8;
  });
  await page.waitForTimeout(400);
}

async function settle(page, ms = 700) {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(ms);
}

export async function shoot({ bb, shots, VARIANTS }) {
  const retry = threadId(bb, RETRY);
  const timeout = threadId(bb, TIMEOUT);

  // The offer above the composer, after the turn that committed.
  for (const [variant, file] of pairs(VARIANTS, "offer", { phone: true })) {
    const page = await openThread(shots, variant, retry, offerReady);
    await settle(page);
    if (variant.isMobile) {
      await shots.still(page, file);
    } else {
      const banner = page.getByRole("button", { name: "Not in this thread" }).first().locator("xpath=ancestor::section[1]");
      await shots.still(page, file, { around: [banner, page.getByRole("button", { name: "Submit (Enter)" }), page.getByRole("button", { name: "Permission mode" })], pad: 16 });
    }
    await shots.closePage(page);
  }

  // Question 2 with its answer form, under the feedback on question 1.
  for (const [variant, file] of pairs(VARIANTS, "question-card", { phone: true, size: (v) => ({ ...v, viewport: { width: 1280, height: 1000 } }) })) {
    const page = await openThread(shots, variant, timeout, cardReady);
    await cardToForm(page);
    await settle(page);
    if (variant.isMobile) {
      await shots.still(page, file);
    } else {
      const feedback = page.getByText("Feedback on question 1", { exact: true }).first().locator("xpath=ancestor::section[1]");
      await shots.still(page, file, { around: [feedback, questionCard(page)] });
    }
    await shots.closePage(page);
  }

  // The Learning tab with the session in progress, beside the thread.
  for (const [variant, file] of pairs(VARIANTS, "learning-tab-session", { phone: true, size: wide })) {
    const page = await openThread(shots, variant, timeout, cardReady);
    await openLearningTab(page);
    await page.getByRole("button", { name: /^Questions and feedback so far/ }).click();
    await page.getByText("Confidence 4/5", { exact: false }).first().waitFor();
    await settle(page);
    await shots.still(page, file);
    await shots.closePage(page);
  }

  // The Orientation section in the Learning tab of the thread that committed, its key files open.
  for (const [variant, file] of pairs(VARIANTS, "orientation", { phone: true, size: wide })) {
    const page = await openThread(shots, variant, retry, offerReady);
    await openLearningTab(page);
    await page.getByRole("button", { name: "Key files" }).click();
    await page.getByText("Wires the config, the pool, the limiter and the routes", { exact: false }).first().waitFor();
    if (variant.isMobile) await page.getByText("ORIENTATION", { exact: false }).first().evaluate((el) => el.scrollIntoView({ block: "start" }));
    await settle(page);
    await shots.still(page, file);
    await shots.closePage(page);
  }

  // The walkthrough tab.
  for (const [variant, file] of pairs(VARIANTS, "walkthrough", { phone: true, size: wide })) {
    const page = await openThread(shots, variant, retry, offerReady);
    await openLearningTab(page);
    await page.getByRole("button", { name: "Read walkthrough" }).click();
    await page.getByText("Listing 1: The server: config, pool, limiter, routes", { exact: true }).waitFor();
    await settle(page);
    await shots.still(page, file);
    await shots.closePage(page);
  }

  // The export dialog, open on the repository's root. Closed with the page: nothing is exported.
  for (const [variant, file] of pairs(VARIANTS, "export", { size: (v) => wide(v, 1200) })) {
    const page = await openThread(shots, variant, retry, offerReady);
    await openLearningTab(page);
    await page.getByRole("button", { name: "Export to repo…" }).click();
    await page.getByRole("button", { name: "Cancel" }).waitFor();
    await page.getByText("README.md", { exact: true }).last().waitFor();
    await settle(page);
    // The section from its summary down to the dialog's buttons, the full width of the panel.
    const purpose = page.getByText(SUMMARY.purpose, { exact: true }).last();
    await shots.still(page, file, { around: [purpose, page.getByLabel("File name"), page.getByRole("button", { name: "Cancel" })] });
    await shots.closePage(page);
  }

  // The demo: from the Learning tab's orientation to the walkthrough, and through its chapters.
  await shots.video(
    "orientation-demo",
    { ...VARIANTS.desktopLight, viewport: { width: 1440, height: 900 } },
    async (page) => {
      await page.goto(new URL(`/threads/${retry}`, page.url()).href, { waitUntil: "networkidle" });
      await offerReady(page);
      await page.waitForTimeout(1200);
      await openLearningTab(page);
      await page.waitForTimeout(1500);
      await page.getByRole("button", { name: "Key files" }).click();
      await page.waitForTimeout(2200);
      await page.getByRole("button", { name: "Read walkthrough" }).click();
      await page.getByText("Listing 1: The server: config, pool, limiter, routes", { exact: true }).waitFor();
      await page.waitForTimeout(2200);
      await chapterPicker(page).selectOption({ label: "The rate limit" });
      await page.waitForTimeout(2500);
      await chapterPicker(page).selectOption({ label: "Retrying on the client" });
      await page.waitForTimeout(2800);
    },
    { formats: ["gif"] },
  );
}
