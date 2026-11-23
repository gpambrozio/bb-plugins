// Shot list for duo-rail: bb on the folded iPhone Duo's cover screen (466×678 pt), with the
// safe-area insets that screen reports (right 84, top 0, bottom 34) set through Chromium's own
// override, so bb pads itself exactly as it does on the device and the rail fills the strip it leaves.
// Run with `npm run shots -- duo-rail` in tools/shots; it writes into duo-rail/docs/screenshots/.
//
// Besides the stills, it checks what a screenshot cannot show: the rail is absent on a desktop window
// and on an ordinary iPhone, bb's sidebar drawer covers it, and its buttons navigate.

/** The folded Duo's cover screen, in CSS px (= pt in bb's web view). */
const COVER = { width: 466, height: 678 };
const DUO_RIGHT = { top: 0, right: 84, bottom: 34, left: 0 };
const DUO_LEFT = { top: 0, right: 0, bottom: 34, left: 84 };
/** An iPhone 16 Pro in portrait: the Dynamic Island's top inset, no side strip. */
const NOTCHED = { top: 62, right: 0, bottom: 34, left: 0 };

export const turns = [
  { match: "signup", reply: "The email field now rejects addresses without a domain, and the error says so under the field." },
  { match: "changelog", reply: "I added an entry for 2.4.0." },
  { match: "flaky", reply: "The test waited on a fixed timeout; it now waits for the request to finish." },
];

let threadId;
let projectId;

export async function seed({ seed }) {
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

export async function shoot({ shots, VARIANTS }) {
  // Desktop: never.
  {
    const page = await shots.page(VARIANTS.desktopLight, threadPath());
    check((await railCount(page)) === 0, "no rail on a desktop window");
    await withInsets(page, DUO_RIGHT);
    check((await railCount(page)) === 0, "no rail on a wide window, even with the Duo's insets");
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
}
