// Shot list for Herald: its page (waiting threads, then recent sentences), a thread with Herald's
// cards in the conversation and its Herald tab opened from the header button, and the Herald choice
// in the thread menu; light and dark, on a desktop window and at phone width; and a demo GIF from the
// page to a thread's tab. Run with `npm run shots -- herald` in tools/shots; it writes into
// herald/docs/screenshots/.
//
// The threads run on the scripted agent: two finished turns on one thread, a permission the agent
// waits on, a failed turn, and a finished turn in a second project. *Write each sentence with a model*
// is on, and the dev bb's `claude` stub answers Herald's `claude -p` with the sentences below, so the
// cards read as model-written ones do. No model runs, and nothing is sent from the browser.
import { THREAD_EVENTS } from "../../tools/shots/lib/seed.mjs";

const WEB = "Acme Web";
const API = "Acme API";
const LOGIN = "Fix login redirect";
const DATES = "Upgrade the date library";
const NIGHTLY = "Nightly test run";
const LIMITS = "Add rate limiting";

export const turns = [
  {
    match: "signing in lands",
    reply:
      "Signing in lands on the home page because the session cookie is written after the redirect, so the dashboard sees no session yet. Setting the cookie first fixes it. Shall I?",
    tools: [
      { title: "Read src/auth/login.ts", kind: "read" },
      { title: "Search for setSessionCookie", kind: "search" },
    ],
  },
  {
    match: "Yes, fix it",
    reply: "Fixed: the session cookie is now set before the redirect, and a new test signs in from a deep link and lands on the dashboard.",
    tools: [
      { title: "Edit src/auth/login.ts", kind: "edit" },
      { title: "Edit test/auth/login.test.ts", kind: "edit" },
      { title: "npm test", kind: "execute" },
    ],
  },
  {
    match: "date library",
    reply: "date-fns 4 takes time zones as an option instead of a second package, so the lockfile has to be rewritten.",
    tools: [{ title: "Read package.json", kind: "read" }],
    permission: { title: "npm install date-fns@4", kind: "execute", command: "npm install date-fns@4" },
  },
  {
    match: "nightly",
    reply: "Running the end-to-end suite.",
    tools: [{ title: "npm run test:e2e", kind: "execute" }],
    error: "The end-to-end browser crashed: out of memory.",
  },
  {
    match: "rate limit",
    reply: "Added a limit of 100 requests a minute per API key. Past it the API answers 429 with a Retry-After header.",
    tools: [
      { title: "Edit src/middleware/rate-limit.ts", kind: "edit" },
      { title: "npm test", kind: "execute" },
    ],
  },
];

/** What the stub `claude -p` answers for each event, matched against the prompt Herald writes. */
const SENTENCES = [
  { match: "now set before the redirect", summary: "Fix login redirect is done: the cookie is set before the redirect, and a new test covers deep links." },
  { match: "written after the redirect", summary: "Fix login redirect found the cause, a cookie set after the redirect, and asks whether to fix it." },
  { match: `Thread: ${DATES}`, summary: "Upgrade the date library wants to run npm install date-fns@4; approve it to go on." },
  { match: `Thread: ${NIGHTLY}`, summary: "Nightly test run stopped: the end-to-end browser ran out of memory." },
  { match: `Thread: ${LIMITS}`, summary: "Add rate limiting is ready: 100 requests a minute per key, then a 429." },
];

/** Waits until Herald has remembered `count` sentences for the thread: its card exists then. */
async function sentences(bb, seed, threadId, count) {
  await bb.waitFor(`Herald's sentence #${count} on ${threadId}`, () => seed.rpc("herald", "history.list", { threadId }).items.length >= count);
}

export async function seed({ bb, seed }) {
  seed.claudePrint(SENTENCES.map(({ match, summary }) => ({ match, reply: { summary, speak: true } })));
  bb.cli(["plugin", "config", "herald", "set", "writeWithModel", "true"]);
  const web = seed.project(WEB, { "README.md": "# Acme Web\n\nThe Acme customer site.\n" });
  const api = seed.project(API, { "README.md": "# Acme API\n\nThe Acme public API.\n" });

  const limits = await seed.thread({ projectId: api.id, title: LIMITS, prompt: "Add rate limiting to the public API" });
  await sentences(bb, seed, limits.id, 1);

  const login = await seed.thread({ projectId: web.id, title: LOGIN, prompt: "Find out why signing in lands on the home page instead of the page I asked for" });
  await sentences(bb, seed, login.id, 1);
  await seed.send({ threadId: login.id, prompt: "Yes, fix it" });
  await sentences(bb, seed, login.id, 2);

  const nightly = await seed.thread({ projectId: web.id, title: NIGHTLY, prompt: "Run the nightly end-to-end suite" });
  await sentences(bb, seed, nightly.id, 1);

  const dates = await seed.thread({
    projectId: web.id,
    title: DATES,
    prompt: "Upgrade the date library to version 4",
    permissionMode: "accept-edits",
    until: THREAD_EVENTS.interaction,
  });
  await sentences(bb, seed, dates.id, 1);
}

const PAGE = "/plugins/herald/waiting";

/** A thread's card in the page's waiting list (the sidebar and Recent sentences have links named alike). */
const waitingCard = (page, title) => page.locator(`div[role="link"][aria-label="Open ${title}"]`);

/** The Herald page with every card and its sentence drawn. */
async function openPage(shots, variant) {
  const page = await shots.page(variant, PAGE);
  await waitingCard(page, DATES).waitFor();
  await page.getByText("Recent sentences", { exact: true }).waitFor();
  await page.getByText(/Add rate limiting is ready/).first().waitFor();
  await page.waitForTimeout(500);
  return page;
}

/** A thread with its newest Herald card drawn. */
async function openThread(shots, variant, threadId) {
  const page = await shots.page(variant, `/threads/${threadId}`);
  await page.getByText("Herald · Finished").last().waitFor();
  await page.getByText(/new test covers deep links/).first().waitFor();
  await page.waitForTimeout(500);
  return page;
}

async function openTab(page) {
  await page.getByRole("button", { name: "Herald: this thread's sentences" }).click();
  await page.getByRole("button", { name: "Close Herald" }).waitFor();
  await page.waitForTimeout(600);
}

export async function shoot({ bb, shots, VARIANTS }) {
  const listed = bb.cliJson(["thread", "list", "--json"]);
  const login = (listed.threads ?? listed).find((thread) => thread.title === LOGIN);
  if (!login) throw new Error(`no "${LOGIN}" thread was seeded`);

  // The page first: opening a thread marks it read, and the page lists waiting threads.
  for (const [variant, file] of [
    [VARIANTS.desktopLight, "page-light.png"],
    [VARIANTS.desktopDark, "page-dark.png"],
    [VARIANTS.phoneLight, "page-phone-light.png"],
    [VARIANTS.phoneDark, "page-phone-dark.png"],
  ]) {
    const page = await openPage(shots, variant);
    await shots.still(page, file);
    await shots.closePage(page);
  }

  // The thread: Herald's cards above each turn's answer, and the Herald tab the header button opens.
  for (const [variant, file] of [
    [VARIANTS.desktopLight, "thread-light.png"],
    [VARIANTS.desktopDark, "thread-dark.png"],
  ]) {
    const page = await openThread(shots, variant, login.id);
    await openTab(page);
    await shots.still(page, file);
    await shots.closePage(page);
  }

  // At phone width the conversation fills the screen; the cards are the shot.
  for (const [variant, file] of [
    [VARIANTS.phoneLight, "thread-phone-light.png"],
    [VARIANTS.phoneDark, "thread-phone-dark.png"],
  ]) {
    const page = await openThread(shots, variant, login.id);
    await shots.still(page, file);
    await shots.closePage(page);
  }

  // The Herald choice in the thread menu.
  for (const [variant, file] of [
    [VARIANTS.desktopLight, "thread-menu-light.png"],
    [VARIANTS.desktopDark, "thread-menu-dark.png"],
  ]) {
    const page = await openThread(shots, variant, login.id);
    const header = page.getByRole("button", { name: "Thread actions" }).last();
    await header.click();
    await page.getByRole("menuitem", { name: /^Herald/ }).hover();
    await page.getByRole("menuitemradio", { name: "Questions only" }).or(page.getByText("Questions only", { exact: true })).first().waitFor();
    await page.waitForTimeout(400);
    await shots.still(page, file, { around: [header, ...(await page.getByRole("menu").all())] });
    await shots.closePage(page);
  }

  // The demo: from the page to the thread, its cards, and its Herald tab. The thread was read by the
  // shots above, so it is flagged unread again to be listed.
  bb.cli(["thread", "unread", login.id]);
  await shots.video(
    "demo",
    { ...VARIANTS.desktopLight, viewport: { width: 1280, height: 720 } },
    async (page) => {
      await page.goto(new URL(PAGE, page.url()).href, { waitUntil: "networkidle" });
      const row = waitingCard(page, LOGIN);
      await row.waitFor();
      await page.waitForTimeout(2200);
      await row.click();
      await page.getByText(/new test covers deep links/).first().waitFor();
      await page.waitForTimeout(2200);
      await openTab(page);
      await page.waitForTimeout(2500);
    },
    { formats: ["gif"] },
  );
}
