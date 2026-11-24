// Shot list for duo-rail: bb on the iPhone Duo's folded cover screen (466×678 pt, a right strip of
// 84) and on its unfolded display (951×669 pt, a right strip of 85), with the safe-area insets each
// reports set through Chromium's own override, so bb pads itself exactly as it does on the device and
// the rail fills the strip it leaves. Run with `npm run shots -- duo-rail` in tools/shots; it writes
// into duo-rail/docs/screenshots/.
//
// Besides the stills, it checks what a screenshot cannot show: the rail is absent on a desktop window
// and on an ordinary iPhone, no bb control sits in the unfolded strip, bb's sidebar drawer covers the
// rail, its buttons navigate, and a layout saved in the Buttons editor reaches the rail, with a
// thread-menu action and a `bb` command that run.

/** The folded Duo's cover screen, in CSS px (= pt in bb's web view). */
const COVER = { width: 466, height: 678 };
const DUO_RIGHT = { top: 0, right: 84, bottom: 34, left: 0 };
const DUO_LEFT = { top: 0, right: 0, bottom: 34, left: 84 };
/** An iPhone 16 Pro in portrait: the Dynamic Island's top inset, no side strip. */
const NOTCHED = { top: 62, right: 0, bottom: 34, left: 0 };
/** The unfolded display, landscape, measured from the owner's screenshot (2853×2007 px at 3×). */
const UNFOLDED = { width: 951, height: 669 };
const UNFOLDED_RIGHT = { top: 0, right: 85, bottom: 21, left: 0 };

export const turns = [
  { match: "signup", reply: "The email field now rejects addresses without a domain, and the error says so under the field." },
  { match: "changelog", reply: "I added an entry for 2.4.0." },
  { match: "flaky", reply: "The test waited on a fixed timeout; it now waits for the request to finish." },
];

let threadId;
let projectId;

export async function seed({ bb, seed }) {
  // bb's command-line tool, for the `bb` command button. The dev bb's HOME is a fake one under its own
  // root, so this links its launcher there and touches nothing of the owner's.
  bb.cli(["settings", "cli-command", "install"]);
  const project = seed.project("Acme Web", { "README.md": "# Acme Web\n" });
  projectId = project.id;
  await seed.thread({ projectId, title: "Update the changelog", prompt: "Add a changelog entry" });
  await seed.thread({ projectId, title: "Fix the flaky upload test", prompt: "Fix the flaky upload test" });
  const thread = await seed.thread({ projectId, title: "Fix the signup form", prompt: "Fix the signup form validation" });
  threadId = thread.id;
}

async function withInsets(page, insets) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
  await page.waitForTimeout(300);
}

async function railCount(page) {
  await page.waitForTimeout(300);
  return page.getByTestId("duo-rail").count();
}

function check(condition, message) {
  if (!condition) throw new Error(`duo-rail check failed: ${message}`);
  console.log(`  ok: ${message}`);
}

const threadPath = () => `/projects/${projectId}/threads/${threadId}`;

/** Whether a tap at the button's centre reaches the button (and not something drawn over it). */
async function tapReaches(page, name) {
  // By label, not role: a covered rail is aria-hidden.
  const button = page.getByTestId("duo-rail").locator(`[aria-label="${name}"]`);
  const box = await button.boundingBox();
  return page.evaluate(
    ({ x, y, label }) => document.elementFromPoint(x, y)?.closest(`[aria-label="${label}"]`) != null,
    { x: box.x + box.width / 2, y: box.y + box.height / 2, label: name },
  );
}

/** Labels of the rail's buttons, top to bottom. */
const railLabels = (page) => page.getByTestId("duo-rail").locator("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));

/** The debug readout's switch (on by default). Off for the stills, on for the debug ones. */
const showDebug = (bb, on) => bb.cli(["plugin", "config", "duo-rail", "set", "showDebugNumbers", String(on)]);

export async function shoot({ bb, shots, VARIANTS }) {
  showDebug(bb, false);
  // Desktop: never.
  {
    const page = await shots.page(VARIANTS.desktopLight, threadPath());
    check((await railCount(page)) === 0, "no rail on a desktop window");
    await shots.closePage(page);
    const narrow = await shots.page({ ...VARIANTS.desktopLight, viewport: COVER }, threadPath());
    check((await railCount(narrow)) === 0, "no rail on a narrow desktop window (bb's phone layout, no insets)");
    await shots.closePage(narrow);
  }

  // The unfolded display: bb's wide layout, the rail in the strip beside it, below its own camera gap.
  for (const [variant, file, menuFile] of [
    [VARIANTS.desktopLight, "unfolded-light.png", "unfolded-more-light.png"],
    [VARIANTS.desktopDark, "unfolded-dark.png", "unfolded-more-dark.png"],
  ]) {
    const page = await shots.page({ ...variant, viewport: UNFOLDED }, threadPath());
    await withInsets(page, UNFOLDED_RIGHT);
    await page.getByText("rejects addresses without a domain").waitFor();
    const rail = page.getByTestId("duo-rail");
    await rail.waitFor();
    check((await rail.getAttribute("data-display")) === "unfolded", "bb's wide layout with the Duo's strip shows the unfolded buttons");
    const box = await rail.boundingBox();
    const stripLeft = UNFOLDED.width - UNFOLDED_RIGHT.right;
    check(Math.round(box.x) === stripLeft && Math.round(box.width) === UNFOLDED_RIGHT.right, "the rail fills exactly the 85 pt unfolded strip");
    check(Math.round(box.y) === 110, "the first button starts 110 pt down, the unfolded camera gap");
    const intruders = await page.evaluate((left) => {
      const controls = document.querySelectorAll("button, a[href], input, textarea, select, [role=button], [role=tab]");
      return [...controls]
        .filter((el) => !el.closest('[data-testid="duo-rail"]'))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.right > left + 0.5;
        })
        .map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40));
    }, stripLeft);
    check(intruders.length === 0, `no bb control reaches into the strip (found: ${intruders.join(", ") || "none"})`);
    for (const name of ["Back", "New thread", "More"]) {
      const b = await rail.getByRole("button", { name }).boundingBox();
      check(b.width >= 44 && b.height >= 44, `unfolded ${name} is at least 44 pt square`);
      check(await tapReaches(page, name), `a tap on unfolded ${name} reaches it`);
    }
    await page.waitForTimeout(500);
    await shots.still(page, file);
    await rail.getByRole("button", { name: "More" }).click();
    const reload = page.getByRole("menuitem", { name: "Reload bb" });
    await reload.waitFor();
    const menu = await page.getByRole("menu").boundingBox();
    const more = await rail.locator(`[aria-label="More"]`).boundingBox(); // aria-hidden while its menu is open
    check(menu.x + menu.width <= more.x && menu.y >= more.y - 1, "More opens as a menu beside its button, into the page, on the wide layout");
    await page.waitForTimeout(600);
    await shots.still(page, menuFile);
    await page.keyboard.press("Escape");
    await shots.closePage(page);
  }

  // An ordinary iPhone: never.
  {
    const page = await shots.page({ ...VARIANTS.phoneLight, viewport: { width: 402, height: 874 } }, threadPath());
    await withInsets(page, NOTCHED);
    check((await railCount(page)) === 0, "no rail on an iPhone with a top inset");
    await withInsets(page, { top: 0, right: 59, bottom: 21, left: 59 });
    check((await railCount(page)) === 0, "no rail with a side inset on both sides");
    await shots.closePage(page);
  }

  for (const [variant, file, menuFile] of [
    [VARIANTS.phoneLight, "cover-light.png", "cover-more-light.png"],
    [VARIANTS.phoneDark, "cover-dark.png", "cover-more-dark.png"],
  ]) {
    const page = await shots.page({ ...variant, viewport: COVER }, threadPath());
    await withInsets(page, DUO_RIGHT);
    await page.getByText("rejects addresses without a domain").waitFor();
    const rail = page.getByTestId("duo-rail");
    await rail.waitFor();
    check((await rail.getAttribute("data-side")) === "right", "the rail sits in the right strip");
    const box = await rail.boundingBox();
    check(Math.round(box.x) === COVER.width - 84 && Math.round(box.width) === 84, "the rail fills exactly the 84 pt strip");
    check(Math.round(box.y) === 175, "the first button starts 175 pt down, below the camera");
    for (const name of ["Back", "New thread", "More"]) {
      const button = rail.getByRole("button", { name });
      const b = await button.boundingBox();
      check(b.width >= 44 && b.height >= 44, `${name} is at least 44 pt square`);
      check(await tapReaches(page, name), `a tap on ${name} reaches it`);
    }
    await page.waitForTimeout(500);
    await shots.still(page, file);

    await rail.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Reload bb" }).waitFor();
    await page.waitForTimeout(600);
    await shots.still(page, menuFile);
    await page.keyboard.press("Escape");
    await shots.closePage(page);
  }

  // Mirrored: the strip, and the rail, are on the left.
  {
    const page = await shots.page({ ...VARIANTS.phoneDark, viewport: COVER }, threadPath());
    await withInsets(page, DUO_LEFT);
    await page.getByText("rejects addresses without a domain").waitFor();
    const rail = page.getByTestId("duo-rail");
    await rail.waitFor();
    check((await rail.getAttribute("data-side")) === "left", "a mirrored device puts the rail in the left strip");
    check(Math.round((await rail.boundingBox()).x) === 0, "the mirrored rail starts at the left edge");
    await page.waitForTimeout(500);
    await shots.still(page, "cover-mirrored-dark.png");
    await shots.closePage(page);
  }

  // The debug numbers, above the top button on both displays, with what this page reads.
  showDebug(bb, true);
  for (const [viewport, insets, display, gap, file] of [
    [COVER, DUO_RIGHT, "folded", 175, "cover-debug-light.png"],
    [UNFOLDED, UNFOLDED_RIGHT, "unfolded", 110, "unfolded-debug-light.png"],
  ]) {
    const page = await shots.page({ ...(display === "folded" ? VARIANTS.phoneLight : VARIANTS.desktopLight), viewport }, threadPath());
    await withInsets(page, insets);
    await page.getByText("rejects addresses without a domain").waitFor();
    const readout = page.getByTestId("duo-rail-debug");
    await readout.waitFor();
    const text = await readout.innerText();
    for (const part of [display, `gap ${gap}`, `safe t0 r${insets.right}`, `b${insets.bottom} l0`, `win ${viewport.width}×${viewport.height}`, "vv ", "scr ", "dpr "]) {
      check(text.includes(part), `the ${display} debug numbers show "${part.trim()}"`);
    }
    const box = await readout.boundingBox();
    const top = await page.getByTestId("duo-rail").boundingBox();
    check(Math.round(box.y + box.height) === Math.round(top.y) && Math.round(box.width) === insets.right, `the ${display} debug numbers sit in the strip right above the top button`);
    check(await tapReaches(page, "Back"), `with the ${display} debug numbers on, a tap on Back still reaches it`);
    await page.waitForTimeout(700);
    await shots.still(page, file);
    await shots.closePage(page);
  }
  showDebug(bb, false);

  // Behaviour: bb's drawer covers the rail, and the buttons navigate.
  {
    const page = await shots.page({ ...VARIANTS.phoneLight, viewport: COVER }, threadPath());
    await withInsets(page, DUO_RIGHT);
    await page.getByTestId("duo-rail").waitFor();
    await page.getByRole("button", { name: /sidebar/i }).first().click();
    await page.waitForTimeout(600);
    check(!(await tapReaches(page, "New thread")), "bb's open sidebar drawer takes the taps over the rail");
    await page.locator('[data-testid="duo-rail"][data-covered]').waitFor({ state: "attached" });
    check(true, "the rail fades out while the drawer is open");
    await shots.still(page, "cover-drawer-open.png");
    await page.keyboard.press("Escape");
    await page.locator('[data-testid="duo-rail"]:not([data-covered])').waitFor();
    check(await tapReaches(page, "New thread"), "the rail comes back and takes taps once the drawer closes");

    await page.getByTestId("duo-rail").getByRole("button", { name: "New thread" }).click();
    await page.waitForFunction((path) => location.pathname !== path, threadPath());
    check(!page.url().includes(`/threads/${threadId}`), "New thread leaves the thread for the new thread screen");
    await page.getByTestId("duo-rail").getByRole("button", { name: "Back" }).click();
    await page.waitForFunction((id) => location.pathname.includes(id), threadId);
    check(true, "Back returns to the thread");

    await page.getByTestId("duo-rail").getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Fix the flaky upload test" }).click();
    await page.getByText("waits for the request to finish").waitFor();
    check(true, "a recent thread in More opens that thread");
    await shots.closePage(page);
  }

  // Proof for the pull request: the rail at work on the cover screen.
  await shots.video(
    "duo-rail-demo",
    { ...VARIANTS.phoneLight, viewport: COVER },
    async (page) => {
      await page.goto(new URL(threadPath(), page.url()).href, { waitUntil: "networkidle" });
      await withInsets(page, DUO_RIGHT);
      const rail = page.getByTestId("duo-rail");
      await page.getByText("rejects addresses without a domain").waitFor();
      await page.waitForTimeout(1500);
      await rail.getByRole("button", { name: "New thread" }).click();
      await page.waitForTimeout(1500);
      await rail.getByRole("button", { name: "Back" }).click();
      await page.getByText("rejects addresses without a domain").waitFor();
      await page.waitForTimeout(1500);
      await rail.getByRole("button", { name: "More" }).click();
      await page.waitForTimeout(1500);
      await page.getByRole("menuitem", { name: "Fix the flaky upload test" }).click();
      await page.getByText("waits for the request to finish").waitFor();
      await page.waitForTimeout(1500);
      await page.getByRole("button", { name: /sidebar/i }).first().click();
      await page.waitForTimeout(1800);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(1500);
    },
    { formats: ["gif"], gifWidth: 466, fps: 12 },
  );

  // And on the unfolded display: its own buttons, More beside the rail.
  await shots.video(
    "duo-rail-unfolded",
    { ...VARIANTS.desktopLight, viewport: UNFOLDED },
    async (page) => {
      await page.goto(new URL(threadPath(), page.url()).href, { waitUntil: "networkidle" });
      await withInsets(page, UNFOLDED_RIGHT);
      const rail = page.getByTestId("duo-rail");
      await page.getByText("rejects addresses without a domain").waitFor();
      await page.waitForTimeout(1500);
      await rail.getByRole("button", { name: "More" }).click();
      await page.waitForTimeout(1500);
      await page.getByRole("menuitem", { name: "Fix the flaky upload test" }).click();
      await page.getByText("waits for the request to finish").waitFor();
      await page.waitForTimeout(1500);
      await rail.getByRole("button", { name: "Back" }).click();
      await page.getByText("rejects addresses without a domain").waitFor();
      await page.waitForTimeout(1500);
    },
    { formats: ["gif"], gifWidth: 951, fps: 12 },
  );

  // The Buttons editor: the folded display gets a thread-menu action and a `bb` command, saved to the
  // server; the unfolded display keeps its own list.
  for (const variant of [VARIANTS.desktopDark, VARIANTS.desktopLight]) {
    const page = await shots.page(variant, "/settings/plugins/duo-rail");
    const editor = page.getByTestId("duo-rail-editor");
    await editor.waitFor();
    check((await editor.getByRole("list", { name: "Buttons" }).getByRole("listitem").count()) >= 3, "the editor lists the default buttons");
    check((await page.getByText("Button layout (JSON)").count()) === 0 && (await page.getByText("Space for the camera, folded").count()) === 1 && (await page.getByText("Show debug numbers").count()) === 1, "the settings page shows the camera gaps, the debug switch and the editor, and no layout JSON");
    await editor.getByRole("button", { name: "Edit More" }).click();
    await editor.getByRole("button", { name: "Edit More" }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await shots.still(page, `editor-${variant.colorScheme}.png`, { around: [editor.getByRole("tablist"), editor.getByRole("listitem", { name: "More" })] });
    await shots.closePage(page);
  }
  {
    const page = await shots.page(VARIANTS.desktopLight, "/settings/plugins/duo-rail");
    const editor = page.getByTestId("duo-rail-editor");
    await editor.waitFor();
    const buttons = editor.getByRole("list", { name: "Buttons" });

    await editor.getByRole("button", { name: "Add button" }).click();
    let row = buttons.locator(":scope > li").last();
    check(await row.getByLabel("Name").evaluate((input) => input === document.activeElement), "a new button opens for editing, its name ready to type");
    await row.getByLabel("Action").selectOption("threadAction");
    const pinOption = (await row.getByLabel("Action from bb's thread menu").locator("option").allTextContents()).find((text) => /^Pin/.test(text));
    check(pinOption !== undefined, "the editor offers bb's own thread-menu actions (Pin among them)");
    await row.getByLabel("Action from bb's thread menu").selectOption({ label: pinOption });
    check((await row.getByLabel("Name").inputValue()) === pinOption, "picking a thread-menu action names the button after it");
    await row.getByRole("radio", { name: "Pin" }).click();
    await buttons.getByRole("button", { name: `Edit ${pinOption}` }).click();

    // A command picked from the list: every plugin's commands and subcommands, and bb's own.
    await editor.getByRole("button", { name: "Add button" }).click();
    row = buttons.locator(":scope > li").last();
    await row.getByLabel("Action").selectOption("bbCommand");
    const box = row.getByRole("combobox", { name: "Command, after bb" });
    await box.focus();
    const list = row.getByRole("listbox", { name: "bb commands" });
    await list.getByRole("option", { name: /^bb thread list/ }).waitFor({ timeout: 30_000 });
    const all = await list.getByRole("option").count();
    check(all > 100, `the command list holds every command, not one (${all})`);
    check((await list.getByRole("option", { name: /^bb automation list/ }).count()) === 1, "it lists a plugin's subcommands (bb automation list)");
    await page.waitForTimeout(300);
    await shots.still(page, "editor-commands-light.png", { around: [row] });
    await box.fill("keep-awake");
    const narrowed = await list.getByRole("option").count();
    check(narrowed > 0 && narrowed < 10, `typing narrows the list (${narrowed} for "keep-awake")`);
    await list.getByRole("option", { name: /^bb keep-awake status/ }).click();
    check((await row.getByLabel("Name").inputValue()) === "keep-awake status", "picking a command names the button after it");
    await buttons.getByRole("button", { name: "Edit keep-awake status" }).click();

    await editor.getByRole("button", { name: "Add button" }).click();
    row = buttons.locator(":scope > li").last();
    await row.getByLabel("Action").selectOption("bbCommand");
    await row.getByLabel("Name").fill("bb version");
    await row.getByRole("combobox", { name: "Command, after bb" }).fill("--version");
    check((await row.getByLabel("Name").inputValue()) === "bb version", "a name the owner typed stays when the command changes");
    await editor.getByRole("button", { name: "Save" }).click();
    await editor.getByText("Saved.", { exact: false }).waitFor();
    check(true, "the editor saves the folded layout");
    await shots.closePage(page);
  }
  {
    const unfolded = await shots.page({ ...VARIANTS.desktopLight, viewport: UNFOLDED }, threadPath());
    await withInsets(unfolded, UNFOLDED_RIGHT);
    await unfolded.getByTestId("duo-rail").waitFor();
    check(JSON.stringify(await railLabels(unfolded)) === JSON.stringify(["Back", "New thread", "More"]), "the unfolded display keeps its own buttons");
    await shots.closePage(unfolded);

    const page = await shots.page({ ...VARIANTS.phoneLight, viewport: COVER }, threadPath());
    await withInsets(page, DUO_RIGHT);
    await page.getByText("rejects addresses without a domain").waitFor();
    const rail = page.getByTestId("duo-rail");
    await rail.waitFor();
    const labels = await railLabels(page);
    check(labels.length === 6 && labels[0] === "Back" && labels[4] === "keep-awake status" && labels[5] === "bb version", `the folded rail follows the saved layout (${labels.join(", ")})`);
    const [first, second] = await Promise.all([0, 1].map((n) => rail.locator("button").nth(n).boundingBox()));
    check(second.y - (first.y + first.height) < 12 && first.height >= 44, `the column is tighter, its buttons still at least 44 pt (gap ${Math.round(second.y - first.y - first.height)} pt)`);
    await rail.locator("button").nth(3).click();
    await bb.waitFor("the thread to be pinned", () => bb.cliJson(["thread", "show", threadId, "--json"]).thread.pinnedAt != null);
    check(true, "the Pin button pins the open thread");
    await rail.getByRole("button", { name: "bb version" }).click();
    const notice = page.locator("[data-sonner-toast]").filter({ hasText: /^bb --version/ });
    await notice.waitFor({ timeout: 30_000 });
    check(/\d+\.\d+\.\d+/.test(await notice.textContent()), "the bb command runs on the server's machine and its output comes back as a notice");
    check((await page.locator("[data-sonner-toast]").filter({ hasText: "Running" }).count()) === 0, "the result takes the place of the running notice");
    await page.waitForTimeout(500);
    await shots.still(page, "cover-custom-light.png");
    await shots.closePage(page);
  }
}
