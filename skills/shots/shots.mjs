// Shot list for the skills plugin: the Skills pop-up in the new-thread composer, light and dark, on
// a desktop window and as bb's bottom sheet at phone width, and a demo of searching it and adding a
// skill to the chat. Run with
// `npm run shots -- skills` in tools/shots; it writes into skills/docs/screenshots/.
//
// The composer is set to Claude Code so the pop-up lists the fixture skills from the demo project
// and the fake HOME's ~/.claude/skills. Nothing is ever sent: the harness refuses any send from the
// browser, and the draft stays a draft.
import { skillFile } from "../../tools/shots/lib/seed.mjs";

const PERSONAL = {
  "release-notes": "Draft user-facing release notes from the commits since the last tag.",
  "review-pr": "Review a pull request for correctness, tests and naming, and leave inline comments.",
  "triage-issue": "Reproduce a reported bug, find the cause and propose a minimal fix.",
  "write-tests": "Add focused unit tests for the change on this branch, following the project's patterns.",
};
const PROJECT = {
  "check-accessibility": "Audit the changed pages for contrast, labels and keyboard access.",
  "deploy-preview": "Build the site and publish a preview deployment for this branch.",
  "update-changelog": "Add an entry to CHANGELOG.md for the change being made.",
};
const PROJECT_NAME = "Acme Web";

const skillTree = (prefix, skills) =>
  Object.fromEntries(Object.entries(skills).map(([name, description]) => [`${prefix}/${name}/SKILL.md`, skillFile(name, description)]));

export async function seed({ seed }) {
  seed.homeFiles(skillTree(".claude/skills", PERSONAL));
  seed.project(PROJECT_NAME, {
    "README.md": "# Acme Web\n\nThe Acme marketing site.\n",
    ...skillTree(".claude/skills", PROJECT),
  });
}

/** From a fresh page to the Skills pop-up open over the new-thread composer, on Claude Code. */
async function openPopup(page, { pause = 0, typing = 0 } = {}) {
  const project = page.getByRole("button", { name: /^Project:/ });
  await project.waitFor();
  if (!(await project.innerText()).includes(PROJECT_NAME)) {
    await project.click();
    await page.waitForTimeout(pause);
    await page.getByRole("dialog").getByText(PROJECT_NAME, { exact: true }).first().click();
  }
  await page.waitForTimeout(pause);
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
  // The plugin's button is "Skills: <count>" once its first scan lands; bb's nav rail has a plain "Skills".
  const skills = page.getByRole("button", { name: /^Skills: \d+/ });
  await skills.waitFor({ timeout: 20_000 });
  await box.click();
  await page.keyboard.type("Prepare the release for ", { delay: typing });
  await page.waitForTimeout(pause);
  await skills.click();
  const search = page.getByPlaceholder(/Search skills/i);
  await search.waitFor();
  await page.getByText("check-accessibility", { exact: true }).waitFor();
  await page.waitForTimeout(400 + pause);
  return { search };
}

export async function shoot({ shots, VARIANTS }) {
  for (const [variant, file] of [
    [VARIANTS.desktopLight, "composer-popup-light.png"],
    [VARIANTS.desktopDark, "composer-popup-dark.png"],
  ]) {
    const page = await shots.page(variant);
    const { search } = await openPopup(page);
    const popup = search.locator("xpath=ancestor::*[@data-radix-popper-content-wrapper or @role='dialog'][1]");
    const around = [page.locator("form").first()];
    if (await popup.count()) around.push(popup);
    await shots.still(page, file, { around });
    await shots.closePage(page);
  }

  // At phone width bb draws the pop-up as its bottom sheet; the whole screen is the shot.
  for (const [variant, file] of [
    [VARIANTS.phoneLight, "composer-popup-phone-light.png"],
    [VARIANTS.phoneDark, "composer-popup-phone-dark.png"],
  ]) {
    const page = await shots.page(variant);
    await openPopup(page);
    await shots.still(page, file);
    await shots.closePage(page);
  }

  await shots.video("composer-popup-demo", { ...VARIANTS.desktopLight, viewport: { width: 1280, height: 720 } }, async (page) => {
    const { search } = await openPopup(page, { pause: 600, typing: 40 });
    await search.pressSequentially("rev", { delay: 150 });
    await page.waitForTimeout(900);
    await page.getByText("review-pr", { exact: true }).first().click();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Add to chat" }).click();
    await page.waitForTimeout(2000);
  }, { formats: ["gif"] });
}
