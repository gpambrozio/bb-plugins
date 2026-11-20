// Shot list for Project Actions. Run with `npm run shots -- project-actions` in tools/shots; it writes
// into project-actions/docs/screenshots/.
//
// Three fixture projects, each a git repository the harness makes, with a thread on the scripted agent:
// - Acme Web has an actions file: a dev server (a script that prints what Vite prints and keeps
//   running), a test run that finishes, a Storybook in a subfolder and a database seed;
// - Docs Site has none, for the empty state;
// - Mobile App has one with a mistake, for the error and where it is.
// The shots: the menu, the dev server running in the thread's terminal panel, the menu again with it
// running, the empty state, the error and the Edit actions tab; light and dark. The first GIF runs the
// dev server from the menu, picks it again (its terminal comes back, no second one starts), then runs
// the tests. The second adds the first action to Docs Site from its empty menu, in the editor, and
// shows it in the menu; it runs last, since it writes Docs Site's actions file.
// The actions really run: each is a terminal of the dev bb, on this Mac, in the fixture's worktree.

const WEB = "Acme Web";
const DOCS = "Docs Site";
const MOBILE = "Mobile App";
const WEB_THREAD = "Add a pricing page";
const DOCS_THREAD = "Fix broken links in the guide";
const MOBILE_THREAD = "Upgrade the navigation library";

const DEV_SERVER = `// Prints what a Vite dev server prints, then keeps running until stopped.
const lines = [
  "",
  "  VITE v6.0.7  ready in 312 ms",
  "",
  "  ➜  Local:   http://localhost:5173/",
  "  ➜  Network: use --host to expose",
  "  ➜  press h + enter to show help",
  "",
];
console.log(lines.join("\\n"));
setInterval(() => {}, 1 << 30);
`;

const TESTS = `// Prints a short test run, then ends.
const files = ["src/pricing.test.ts", "src/cart.test.ts", "src/checkout.test.ts"];
let passed = 0;
for (const file of files) {
  const count = 3 + file.length % 4;
  passed += count;
  console.log(\` ✓ \${file} (\${count} tests)\`);
}
console.log(\`\\n Test Files  \${files.length} passed (\${files.length})\\n      Tests  \${passed} passed (\${passed})\\n\`);
`;

const WEB_ACTIONS = {
  actions: [
    { name: "Dev server", command: "node scripts/dev-server.mjs", description: "Vite on http://localhost:5173" },
    { name: "Run tests", command: "node scripts/test.mjs" },
    { name: "Storybook", command: "node ../../scripts/dev-server.mjs", cwd: "packages/ui", description: "The component gallery" },
    { name: "Seed database", command: "sh scripts/seed.sh", description: "Reset the local database with sample data" },
  ],
};

const WEB_FILES = {
  "README.md": "# Acme Web\n\nThe Acme storefront.\n",
  "package.json": `${JSON.stringify({ name: "acme-web", private: true, type: "module", scripts: { dev: "vite", test: "vitest run" } }, null, 2)}\n`,
  ".bb/actions.json": `${JSON.stringify(WEB_ACTIONS, null, 2)}\n`,
  "scripts/dev-server.mjs": DEV_SERVER,
  "scripts/test.mjs": TESTS,
  "scripts/seed.sh": 'echo "Seeded 24 products and 3 customers."\n',
  "packages/ui/README.md": "# UI components\n",
};

const DOCS_FILES = { "README.md": "# Docs Site\n\nThe Acme guide.\n" };

/** A mistake on line 6: the second action has no command. */
const MOBILE_FILES = {
  "README.md": "# Mobile App\n",
  ".bb/actions.json": `{
  "actions": [
    { "name": "iOS simulator", "command": "npx expo run:ios" },
    {
      "name": "Android emulator",
      "comand": "npx expo run:android"
    }
  ]
}
`,
};

export const turns = [
  { match: "pricing page", reply: "I added `src/pages/pricing.tsx` with the three plans, and a link to it in the header." },
  { match: "broken links", reply: "I fixed four links in `guide/getting-started.md` that pointed at pages renamed last month." },
  { match: "navigation library", reply: "I upgraded the navigation library and moved the two screens whose options changed." },
];

export async function seed({ seed }) {
  const web = seed.project(WEB, WEB_FILES);
  const docs = seed.project(DOCS, DOCS_FILES);
  const mobile = seed.project(MOBILE, MOBILE_FILES);
  await seed.thread({ projectId: web.id, title: WEB_THREAD, prompt: "Add a pricing page" });
  await seed.thread({ projectId: docs.id, title: DOCS_THREAD, prompt: "Fix the broken links in the guide" });
  await seed.thread({ projectId: mobile.id, title: MOBILE_THREAD, prompt: "Upgrade the navigation library" });
}

function threadId(bb, title) {
  const listed = bb.cliJson(["thread", "list", "--json"]);
  const thread = (listed.threads ?? listed).find((candidate) => candidate.title === title);
  if (!thread) throw new Error(`no "${title}" thread was seeded`);
  return thread.id;
}

const pairs = (VARIANTS, base) => [
  [VARIANTS.desktopLight, `${base}-light.png`],
  [VARIANTS.desktopDark, `${base}-dark.png`],
];

async function settle(page, ms = 700) {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(ms);
}

async function openThread(shots, variant, id) {
  const page = await shots.page(variant, `/threads/${id}`);
  await page.getByRole("button", { name: "Project actions" }).waitFor();
  return page;
}

/** Opens the menu and waits for it to have read the file. */
async function openMenu(page, ready) {
  await page.getByRole("button", { name: "Project actions" }).click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  await ready(menu);
  return menu;
}

const actionsReady = (menu) => menu.getByRole("menuitem", { name: /Dev server/ }).waitFor();

/** The menu with the header button it hangs from (by attribute: an open menu hides the page from roles). */
function aroundMenu(page, menu) {
  return { around: [menu, page.locator('button[aria-label="Project actions"]')], pad: 24 };
}

/**
 * Waits until the thread's terminal titled `title` has printed `text`, then for bb to draw it. bb
 * draws terminals on a WebGL canvas, so the page has no text to wait on; the dev bb's CLI reads it.
 */
async function terminalShows(bb, page, threadIdValue, title, text) {
  await bb.waitFor(`"${text}" in the ${title} terminal`, () => {
    const listed = bb.cliJson(["terminal", "list", "--thread", threadIdValue, "--json"]);
    return (listed.sessions ?? []).some((session) => session.title === title && bb.cli(["terminal", "output", session.id, "--plain"]).includes(text));
  });
  await page.waitForTimeout(1500);
}

/**
 * Headless Chromium does not capture bb's WebGL terminal at 2×: the panel comes out blank. Shots
 * that show a terminal are taken at 1× (still 1280 pixels wide).
 */
const oneX = (variant) => ({ ...variant, deviceScaleFactor: 1 });

/** Closes every terminal the shots started, so each variant starts from the same state. */
function closeTerminals(bb, threadIdValue) {
  const listed = bb.cliJson(["terminal", "list", "--thread", threadIdValue, "--json"]);
  for (const session of listed.sessions ?? []) bb.cli(["terminal", "close", session.id]);
}

export async function shoot({ bb, shots, VARIANTS }) {
  const web = threadId(bb, WEB_THREAD);
  const docs = threadId(bb, DOCS_THREAD);
  const mobile = threadId(bb, MOBILE_THREAD);

  // The menu, as the user meets it.
  for (const [variant, file] of pairs(VARIANTS, "menu")) {
    const page = await openThread(shots, variant, web);
    const menu = await openMenu(page, actionsReady);
    await settle(page);
    await shots.still(page, file, aroundMenu(page, menu));
    await shots.closePage(page);
  }

  // The dev server running in the thread's terminal panel, then the menu that says so.
  for (const [variant, suffix] of [
    [VARIANTS.desktopLight, "light"],
    [VARIANTS.desktopDark, "dark"],
  ]) {
    const page = await openThread(shots, oneX(variant), web);
    const menu = await openMenu(page, actionsReady);
    await menu.getByRole("menuitem", { name: /Dev server/ }).click();
    await terminalShows(bb, page, web, "Dev server", "ready in 312 ms");
    await settle(page, 1200);
    await shots.still(page, `running-${suffix}.png`);
    await shots.closePage(page);
    // The menu itself has no terminal in it, so it is shot at 2× like the others.
    const sharp = await openThread(shots, variant, web);
    const again = await openMenu(sharp, (opened) => opened.getByText("Running", { exact: true }).waitFor());
    await settle(sharp);
    await shots.still(sharp, `menu-running-${suffix}.png`, aroundMenu(sharp, again));
    await shots.closePage(sharp);
    closeTerminals(bb, web);
  }

  // No actions file.
  for (const [variant, file] of pairs(VARIANTS, "empty")) {
    const page = await openThread(shots, variant, docs);
    const menu = await openMenu(page, (opened) => opened.getByText("No actions in this project").waitFor());
    await settle(page);
    await shots.still(page, file, aroundMenu(page, menu));
    await shots.closePage(page);
  }

  // A mistake in the file, and where it is.
  for (const [variant, file] of pairs(VARIANTS, "invalid")) {
    const page = await openThread(shots, variant, mobile);
    const menu = await openMenu(page, (opened) => opened.getByText("The actions file has a problem").waitFor());
    await settle(page);
    await shots.still(page, file, aroundMenu(page, menu));
    await shots.closePage(page);
  }

  // The demo: run the dev server, pick it again (its terminal comes back), then run the tests.
  await shots.video(
    "demo",
    VARIANTS.desktopLight,
    async (page) => {
      await page.goto(new URL(`/threads/${web}`, page.url()).href);
      await page.getByRole("button", { name: "Project actions" }).waitFor();
      await page.waitForTimeout(1000);
      let menu = await openMenu(page, actionsReady);
      await page.waitForTimeout(1000);
      await menu.getByRole("menuitem", { name: /Dev server/ }).click();
      await terminalShows(bb, page, web, "Dev server", "ready in 312 ms");
      await page.waitForTimeout(1800);
      menu = await openMenu(page, (opened) => opened.getByText("Running", { exact: true }).waitFor());
      await page.waitForTimeout(1200);
      await menu.getByRole("menuitem", { name: /Run tests/ }).click();
      await terminalShows(bb, page, web, "Run tests", "passed (");
      await page.waitForTimeout(1800);
      menu = await openMenu(page, (opened) => opened.getByText("Finished", { exact: true }).waitFor());
      await page.waitForTimeout(1200);
      await menu.getByRole("menuitem", { name: /Dev server/ }).click();
      await page.waitForTimeout(2500);
    },
    { formats: ["gif"] },
  );
  closeTerminals(bb, web);

  // The editor beside the thread, opened from the menu.
  for (const [variant, file] of pairs(VARIANTS, "editor")) {
    const page = await openThread(shots, { ...variant, viewport: { width: 1440, height: 1000 } }, web);
    const menu = await openMenu(page, actionsReady);
    await menu.getByRole("menuitem", { name: "Edit actions…" }).click();
    await page.getByRole("listitem", { name: "Dev server" }).waitFor();
    // A field with a mistake, to show the check the menu makes, then back to the tab's top.
    await page.getByRole("listitem", { name: "Run tests" }).getByLabel(/Folder/).fill("../tests");
    await page.getByRole("heading", { name: "Edit actions" }).evaluate((heading) => heading.scrollIntoView({ block: "start" }));
    await page.getByRole("listitem", { name: "Run tests" }).getByText('"cwd" must stay inside the project (no ..)').waitFor();
    await settle(page);
    await shots.still(page, file);
    await shots.closePage(page);
  }

  // The demo: a project with no actions gets its first one in the editor, and the menu lists it.
  await shots.video(
    "editor-demo",
    VARIANTS.desktopLight,
    async (page) => {
      await page.goto(new URL(`/threads/${docs}`, page.url()).href);
      await page.getByRole("button", { name: "Project actions" }).waitFor();
      await page.waitForTimeout(800);
      let menu = await openMenu(page, (opened) => opened.getByText("No actions in this project").waitFor());
      await page.waitForTimeout(1200);
      await menu.getByRole("menuitem", { name: "Add actions" }).click();
      const first = page.getByRole("listitem", { name: "Action 1" });
      await first.waitFor();
      await page.waitForTimeout(800);
      await first.getByLabel(/Name/).pressSequentially("Docs preview", { delay: 60 });
      const row = page.getByRole("listitem", { name: "Docs preview" });
      await row.getByLabel(/Command/).pressSequentially("npm run docs:dev", { delay: 50 });
      await row.getByLabel(/Description/).pressSequentially("The guide on http://localhost:4000", { delay: 30 });
      await page.waitForTimeout(600);
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByText(/Saved in this worktree/).waitFor();
      await page.waitForTimeout(1500);
      menu = await openMenu(page, (opened) => opened.getByRole("menuitem", { name: /Docs preview/ }).waitFor());
      await page.waitForTimeout(2000);
      await page.keyboard.press("Escape");
    },
    { formats: ["gif"] },
  );
}
