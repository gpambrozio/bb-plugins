// Shot list for the Code Mode plugin: "Send in Code Mode" in the new-thread composer's Send menu, and
// the plugin's settings page (two projects with one name share a row), light and dark. Run with `npm run shots -- code-mode` in tools/shots; it
// writes into code-mode/docs/screenshots/.
//
// The screenshot dev bb's Claude Code is a stub that never runs a session, so nothing here is sent: the
// draft stays a draft. The images of a Code Mode thread (its row badge and thread-menu line) and the
// demo GIF come from a live run instead (see AGENTS.md).

const PLUGIN = "code-mode";
const PROJECT_NAME = "Acme Web";

export async function seed({ bb, seed }) {
  // Two projects share a name, as the same repository checked out twice does; the page lists the name
  // once, and its switch covers both.
  seed.project(PROJECT_NAME, { "README.md": "# Acme Web\n\nThe Acme marketing site.\n" });
  seed.project(PROJECT_NAME, { "README.md": "# Acme Web\n\nA second checkout.\n" }, { folder: "acme-web-redesign" });
  seed.project("Billing API", { "README.md": "# Billing API\n" });
  seed.project("Docs Site", { "README.md": "# Docs Site\n" });
  const [machine] = bb.cliJson(["machine", "list", "--json"]);
  seed.rpc(PLUGIN, "config.setHost", { hostId: machine.id, on: true });
  seed.rpc(PLUGIN, "config.setProjectName", { name: PROJECT_NAME, on: true });
}

/** From a fresh page to the Send menu open over the new-thread composer, on Claude Code. */
async function openSendMenu(page, { pause = 0, typing = 0 } = {}) {
  const project = page.getByRole("button", { name: /^Project:/ });
  await project.waitFor();
  if (!(await project.innerText()).includes(PROJECT_NAME)) {
    await project.click();
    await page.waitForTimeout(pause);
    await page.getByRole("dialog").getByText(PROJECT_NAME, { exact: true }).first().click();
  }
  // The dev bb's default is the scripted agent. Claude Code's provider tabs have no accessible
  // name, so step through providers with bb's own Alt+P until a Claude model shows.
  const box = page.getByRole("textbox").first();
  await box.click();
  const picker = page.getByRole("button", { name: /Provider, model and reasoning/ });
  for (let i = 0; i < 8 && !/Opus|Sonnet|Haiku|Fable/.test(await picker.innerText()); i++) {
    await page.keyboard.press("Alt+KeyP");
    await page.waitForTimeout(250 + pause / 3);
  }
  if (!/Opus|Sonnet|Haiku|Fable/.test(await picker.innerText())) throw new Error(`could not pick Claude Code; the picker reads "${await picker.innerText()}"`);
  await box.click();
  await page.keyboard.type("Refactor the pricing page's data loading into one module", { delay: typing });
  await page.waitForTimeout(400 + pause);
  await page.getByRole("button", { name: "Send options" }).click();
  const row = page.getByRole("menuitem", { name: "Send in Code Mode" });
  await row.waitFor();
  await row.hover();
  await page.waitForTimeout(400 + pause);
  return { row };
}

export async function shoot({ shots, VARIANTS }) {
  for (const variant of [VARIANTS.desktopLight, VARIANTS.desktopDark]) {
    const page = await shots.page(variant);
    const { row } = await openSendMenu(page);
    await shots.still(page, `send-menu-${variant.colorScheme}.png`, { around: [page.locator("form").first(), row.locator("xpath=ancestor::*[@role='menu'][1]")] });
    await shots.closePage(page);
  }

  for (const variant of [VARIANTS.desktopLight, VARIANTS.desktopDark]) {
    const page = await shots.page(variant, `/settings/plugins/${PLUGIN}`);
    await page.getByText("Projects that start in Code Mode").waitFor();
    await page.getByText(PROJECT_NAME, { exact: true }).waitFor();
    await page.waitForTimeout(600);
    await page.getByText("Wrapper ready").waitFor();
    await shots.still(page, `settings-${variant.colorScheme}.png`);
    await shots.closePage(page);
  }
}
