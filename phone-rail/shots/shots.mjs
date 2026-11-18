// Shot list for phone-rail: the same bb at desktop and phone width, the desktop rail with every
// icon and the phone's rail with three, and the phone editor open. Run with `npm run shots --
// phone-rail` in tools/shots; it writes into phone-rail/docs/screenshots/.
//
// The rail's destinations are fixtures: one throwaway plugin, written into the dev bb's root and
// installed from there, that adds eight sidebar pages and nothing else. The phone layout is set
// through Phone Rail's own RPC, as the phone editor would save it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_ID = "workspace-tools";

/** The fixture's sidebar pages: [path, title, bb icon]. */
const PANELS = [
  ["notes", "Notes", "FileText"],
  ["calendar", "Calendar", "Calendar"],
  ["mail", "Mail", "Mail"],
  ["reviews", "Reviews", "GitPullRequest"],
  ["metrics", "Metrics", "ChartColumn"],
  ["deploys", "Deploys", "Cloud"],
  ["news", "News", "News01"],
  ["browser", "Browser", "Globe"],
];

const panelId = ([path]) => `${FIXTURE_ID}/${path}`;

/**
 * A 402-point-wide phone (an iPhone 16 Pro) rather than the harness's 390: at the harness's 3x
 * that is 1206 pixels, over the Community marketplace's 1200-pixel minimum width.
 */
const PHONE_VIEWPORT = { width: 402, height: 874 };

/** What phones show: three pages, Reviews first. Everything else stays in More. */
const PHONE_LAYOUT = {
  visible: ["workspace-tools/reviews", "workspace-tools/mail", "workspace-tools/calendar"],
  order: ["workspace-tools/reviews", "workspace-tools/mail", "workspace-tools/calendar"],
};

function writeFixturePlugin(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: `bb-plugin-${FIXTURE_ID}`,
        version: "0.0.0",
        private: true,
        type: "module",
        bb: {
          name: "Workspace tools",
          description: "Eight sidebar pages for Phone Rail's screenshots.",
          branding: { icon: "Toolbox" },
          server: "./server.ts",
          app: "./app.tsx",
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, "server.ts"), "export default function plugin() {}\n");
  writeFileSync(
    join(dir, "app.tsx"),
    `import { definePluginApp } from "@get-bb/plugin-sdk/app";

const PANELS = ${JSON.stringify(PANELS)};

export default definePluginApp((app) => {
  for (const [path, title, icon] of PANELS) {
    app.slots.navPanel({
      id: path,
      title,
      icon,
      path,
      component: () => <div className="p-6 text-sm text-muted-foreground">{title}</div>,
    });
  }
});
`,
  );
}

export async function seed({ bb, seed }) {
  const fixture = join(bb.cfg.root, "fixtures", FIXTURE_ID);
  writeFixturePlugin(fixture);
  seed.installPlugin(fixture);

  bb.cli(["settings", "ui", "set", "sidebar.navigationProvider", "phone-rail/rail"]);
  // Desktop: bb's shared preferences show every page, in the fixture's order.
  const shared = ["__bb__/new-thread", "__bb__/extensions", "__bb__/skills", "__bb__/automations", ...PANELS.map(panelId)];
  bb.cli(["settings", "ui", "set", "sidebar.visiblePluginPanels", JSON.stringify(shared)]);
  bb.cli(["settings", "ui", "set", "sidebar.pluginPanelOrder", JSON.stringify(shared)]);
  seed.rpc("phone-rail", "setPhoneLayout", { layout: PHONE_LAYOUT });

  const project = seed.project("Acme Web", { "README.md": "# Acme Web\n" });
  await seed.thread({ projectId: project.id, title: "Fix the signup form", prompt: "Fix the signup form validation" });
  await seed.thread({ projectId: project.id, title: "Update the changelog", prompt: "Add a changelog entry" });
}

export const turns = [
  { match: "signup", reply: "The email field now rejects addresses without a domain." },
  { match: "changelog", reply: "I added an entry for 2.4.0." },
];

/** The phone's sidebar drawer, opened from the header. */
async function openPhoneSidebar(page) {
  await page.getByRole("button", { name: /sidebar/i }).first().click();
  await page.getByTestId("app-nav-rail").waitFor();
  await page.waitForTimeout(400);
}

export async function shoot({ shots, VARIANTS }) {
  for (const [variant, file] of [
    [VARIANTS.desktopLight, "desktop-light.png"],
    [VARIANTS.desktopDark, "desktop-dark.png"],
  ]) {
    const page = await shots.page(variant);
    await page.getByRole("button", { name: "Reviews" }).waitFor();
    await page.getByRole("textbox").first().waitFor();
    await page.waitForTimeout(800);
    await shots.still(page, file);
    await shots.closePage(page);
  }

  for (const [variant, rail, editor] of [
    [VARIANTS.phoneLight, "phone-light.png", "phone-editor-light.png"],
    [VARIANTS.phoneDark, "phone-dark.png", "phone-editor-dark.png"],
  ]) {
    const page = await shots.page({ ...variant, viewport: PHONE_VIEWPORT });
    await openPhoneSidebar(page);
    await page.getByRole("button", { name: "Reviews" }).waitFor();
    await shots.still(page, rail);

    await page.getByTestId("app-nav-rail").getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Customize navigation" }).click();
    await page.getByTestId("phone-rail-editor").waitFor();
    await page.waitForTimeout(600);
    await shots.still(page, editor);
    await shots.closePage(page);
  }
}
