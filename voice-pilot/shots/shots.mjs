// Shot list for Voice Pilot. Run with `npm run shots -- voice-pilot` in tools/shots; it writes into
// voice-pilot/docs/screenshots/.
//
// The shots harness's dev bb has no way to OpenAI (its OPENAI_BASE_URL is a closed port and it has no
// sign-in), so no call is made here: these are the surfaces as you meet them before you tap Talk. The live
// session (greeting, a question answered by voice, hooks) is `scripts/e2e-desktop.ts`, against a dev bb that
// can reach OpenAI; its screenshots go on the pull request.
//
// One fixture project with three threads on the scripted agent: one working (its turn held), one waiting on
// a permission request, one finished. The shots: the Voice page in the sidebar, light and dark; Talk in a
// thread's header; the settings page with the instructions and the voice hooks; the Voice page on a phone.
import { THREAD_EVENTS } from "../../tools/shots/lib/seed.mjs";

const PROJECT = "Acme Web";

export const turns = [
  { match: "payment", reply: "Working on the payment retries.", waitFor: "payments-done" },
  {
    match: "release notes",
    reply: "I drafted the release notes.",
    permission: { title: "Publish the release notes draft", kind: "execute", command: "node scripts/publish-notes.mjs --draft" },
  },
  { match: "flaky", reply: "The login test was racing the session cookie; it now waits for it. All green." },
];

export async function seed({ seed }) {
  const web = seed.project(PROJECT, { "README.md": "# Acme Web\n\nThe Acme storefront.\n" });
  await seed.thread({ projectId: web.id, title: "Fix the flaky login test", prompt: "Fix the flaky login test" });
  await seed.thread({
    projectId: web.id,
    title: "Draft the release notes",
    prompt: "Draft the release notes",
    permissionMode: "accept-edits",
    until: THREAD_EVENTS.interaction,
  });
  await seed.thread({ projectId: web.id, title: "Retry failed payments", prompt: "Retry failed payments", until: THREAD_EVENTS.turnStarted });
}

function threadId(bb, title) {
  const listed = bb.cliJson(["thread", "list", "--json"]);
  const thread = (listed.threads ?? listed).find((candidate) => candidate.title === title);
  if (!thread) throw new Error(`no "${title}" thread was seeded`);
  return thread.id;
}

async function settle(page, ms = 700) {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(ms);
}

async function voicePage(shots, variant) {
  const page = await shots.page(variant, "/plugins/voice-pilot/voice");
  await page.getByRole("button", { name: /^Talk$/u }).first().waitFor();
  await page.getByText("No voice session since Voice Pilot loaded").waitFor();
  return page;
}

export async function shoot({ bb, shots, VARIANTS }) {
  for (const [variant, file] of [
    [VARIANTS.desktopLight, "voice-page-light.png"],
    [VARIANTS.desktopDark, "voice-page-dark.png"],
  ]) {
    const page = await voicePage(shots, variant);
    await settle(page);
    await shots.still(page, file);
    await shots.closePage(page);
  }

  // Talk in a thread's header: the thread waiting on a permission, as you would talk to answer it.
  const waiting = threadId(bb, "Draft the release notes");
  {
    const page = await shots.page(VARIANTS.desktopLight, `/threads/${waiting}`);
    const talk = page.getByRole("button", { name: /^Talk$/u }).first();
    await talk.waitFor();
    await settle(page);
    await shots.still(page, "thread-header-light.png");
    await shots.closePage(page);
  }

  // The settings: connection, model, announcements, the instructions (greeting included) and the hooks.
  {
    const page = await shots.page(VARIANTS.desktopLight, "/settings/plugins/voice-pilot");
    await page.getByText("Voice hooks").first().waitFor();
    await page.getByText(/Has no|No hook file|Did not answer/u).first().waitFor();
    await settle(page);
    await shots.still(page, "settings-light.png");
    await page.getByText("Voice hooks").first().evaluate((node) => node.scrollIntoView({ block: "start" }));
    await settle(page);
    await shots.still(page, "settings-hooks-light.png");
    await shots.closePage(page);
  }

  for (const [variant, file] of [
    [VARIANTS.phoneLight, "voice-page-phone-light.png"],
    [VARIANTS.phoneDark, "voice-page-phone-dark.png"],
  ]) {
    const page = await voicePage(shots, variant);
    await settle(page);
    await shots.still(page, file);
    await shots.closePage(page);
  }
}
