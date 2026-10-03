import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CHARTER_FILE,
  NEW_CHARTER_FILE,
  acknowledgeCharter,
  fingerprint,
  readCharterState,
  syncCharter,
  writeNewCharter,
  type PluginCharter,
} from "./charter-file";
import { prepareHome, type HomeConfig } from "./home";
import { TEMPLATES, fill, readTemplate } from "./templates";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "fm-home-"));
  tempDirs.push(home);
  await mkdir(join(home, "data"), { recursive: true });
  return home;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const homeConfig: HomeConfig = { crewProvider: "", crewReasoning: "" };
const read = (home: string, file: string) => readFile(join(home, file), "utf8");

/** Replaces what the copy says, keeping its note — an edit made in the panel. */
async function editCopy(home: string, words: string): Promise<void> {
  const copy = await read(home, CHARTER_FILE);
  const noteEnd = copy.indexOf("-->") + 3;
  await writeFile(join(home, CHARTER_FILE), `${copy.slice(0, noteEnd)}\n\n${words}\n`, "utf8");
}

// Two versions of the plugin's charter templates, as two releases would ship them.
const BODY1 = "# First mate\n\nVersion one. Home: {{home}}.";
const BODY2 = "# First mate\n\nVersion two. Home: {{home}}.";
const NEW = "<!-- for comparing -->\n\n{{charter}}\n";
const V1: PluginCharter = { charter: `<!-- firstmate-charter {{fingerprint}} -->\n\n${BODY1}\n`, charterNew: NEW };
const V2: PluginCharter = { charter: `<!-- firstmate-charter {{fingerprint}} -->\n\n${BODY2}\n`, charterNew: NEW };

describe("syncCharter", () => {
  it("writes the plugin's charter under a note with its fingerprint", async () => {
    const home = await tempHome();
    const state = await syncCharter(home, V1);
    expect(state).toEqual({ template: BODY1, edited: false, outdated: false });
    const copy = await read(home, CHARTER_FILE);
    expect(copy).toBe(fill(V1.charter, { fingerprint: fingerprint(V1.charter) }));
    expect(fingerprint(V1.charter)).toBe(fingerprint(BODY1));
    expect(await exists(join(home, NEW_CHARTER_FILE))).toBe(false);
  });

  it("follows the plugin while the captain has not edited it", async () => {
    const home = await tempHome();
    await syncCharter(home, V1);
    const state = await syncCharter(home, V2);
    expect(state).toEqual({ template: BODY2, edited: false, outdated: false });
    expect(await read(home, CHARTER_FILE)).toContain("Version two.");
  });

  it("keeps an edited copy, and puts a changed plugin charter beside it until the captain is done", async () => {
    const home = await tempHome();
    await syncCharter(home, V1);
    await editCopy(home, "# My first mate\n\nHome: {{home}}. Speak like a pirate.");

    // The same plugin charter: the edit is simply the captain's.
    expect(await syncCharter(home, V1)).toMatchObject({ edited: true, outdated: false });
    expect(await exists(join(home, NEW_CHARTER_FILE))).toBe(false);

    // A new plugin charter: the edit is kept and used, and the new one is offered for comparison.
    const state = await syncCharter(home, V2);
    expect(state).toEqual({ template: "# My first mate\n\nHome: {{home}}. Speak like a pirate.", edited: true, outdated: true });
    expect(await read(home, CHARTER_FILE)).toContain("Speak like a pirate.");
    expect(await read(home, NEW_CHARTER_FILE)).toContain("Version two.");
    expect((await readCharterState(home, V2)).outdated).toBe(true);

    await acknowledgeCharter(home, V2);
    expect(await exists(join(home, NEW_CHARTER_FILE))).toBe(false);
    expect(await read(home, CHARTER_FILE)).toContain("Speak like a pirate.");
    expect(await readCharterState(home, V2)).toMatchObject({ edited: true, outdated: false });
    expect(await syncCharter(home, V2)).toMatchObject({ edited: true, outdated: false });
  });

  it("goes back to the plugin's charter when the copy is emptied or deleted", async () => {
    const home = await tempHome();
    await syncCharter(home, V1);
    await editCopy(home, "Mine.");
    await writeFile(join(home, CHARTER_FILE), "<!-- nothing but a note -->\n", "utf8");
    expect(await syncCharter(home, V2)).toEqual({ template: BODY2, edited: false, outdated: false });
    expect(await read(home, CHARTER_FILE)).toContain(`firstmate-charter ${fingerprint(V2.charter)}`);

    await rm(join(home, CHARTER_FILE));
    expect(await syncCharter(home, V2)).toMatchObject({ edited: false });
    expect(await exists(join(home, CHARTER_FILE))).toBe(true);
  });

  it("treats a copy without its note as edited from nothing, and Done gives the note back", async () => {
    const home = await tempHome();
    await writeFile(join(home, CHARTER_FILE), "# Written from scratch\n", "utf8");
    expect(await syncCharter(home, V1)).toMatchObject({ edited: true, outdated: true });

    await acknowledgeCharter(home, V1);
    const copy = await read(home, CHARTER_FILE);
    expect(copy).toContain(`firstmate-charter ${fingerprint(V1.charter)}`);
    expect(copy).toContain("# Written from scratch");
    expect(await readCharterState(home, V1)).toMatchObject({ edited: true, outdated: false });
  });

  it("keeps an edit saved while the acknowledgement was writing, and acknowledges it", async () => {
    const home = await tempHome();
    await syncCharter(home, V1);
    await editCopy(home, "Speak like a pirate.");
    await syncCharter(home, V2);

    let edits = 0;
    await acknowledgeCharter(home, V2, {
      afterStaging: async () => {
        if (edits++ === 0) await editCopy(home, "Speak like a pirate. And sing.");
      },
    });
    const copy = await read(home, CHARTER_FILE);
    expect(copy).toContain("Speak like a pirate. And sing.");
    expect(copy).toContain(`firstmate-charter ${fingerprint(V2.charter)}`);
    expect(await exists(join(home, NEW_CHARTER_FILE))).toBe(false);
  });

  it("gives up with a sentence when the charter keeps changing, and leaves the last edit", async () => {
    const home = await tempHome();
    await syncCharter(home, V1);
    await editCopy(home, "Mine.");
    await syncCharter(home, V2);

    let edits = 0;
    await expect(
      acknowledgeCharter(home, V2, {
        afterStaging: () => editCopy(home, `Mine, edit ${++edits}.`),
      }),
    ).rejects.toThrow("data/charter.md kept changing while it was being marked up to date. Try again.");
    expect(await read(home, CHARTER_FILE)).toContain(`Mine, edit ${edits}.`);
    expect(await exists(join(home, NEW_CHARTER_FILE))).toBe(true);
  });

  it("refuses a charter copy that is a link out of the home", async () => {
    const home = await tempHome();
    const outside = await tempHome();
    const victim = join(outside, "notes.md");
    await writeFile(victim, "not the plugin's", "utf8");
    await mkdir(join(home, "data"), { recursive: true });
    await symlink(victim, join(home, CHARTER_FILE));

    await expect(syncCharter(home, V1)).rejects.toThrow(/leads outside the home/);
    await expect(acknowledgeCharter(home, V1)).rejects.toThrow(/leads outside the home/);
    expect(await readFile(victim, "utf8")).toBe("not the plugin's");
  });

  it("keeps an edit the captain saves while an untouched copy is being updated", async () => {
    const home = await tempHome();
    await syncCharter(home, V1);

    let edits = 0;
    const state = await syncCharter(home, V2, {
      afterStaging: async () => {
        if (edits++ === 0) await editCopy(home, "Speak like a pirate.");
      },
    });
    expect(state).toMatchObject({ edited: true, outdated: true });
    const copy = await read(home, CHARTER_FILE);
    expect(copy).toContain("Speak like a pirate.");
    expect(copy).toContain(`firstmate-charter ${fingerprint(V1.charter)}`);
    expect(await read(home, NEW_CHARTER_FILE)).toContain("Version two.");
  });

  it("keeps a charter the captain writes while a missing one is being created", async () => {
    const home = await tempHome();
    await mkdir(join(home, "data"), { recursive: true });

    const state = await syncCharter(home, V1, {
      beforeCreate: () => writeFile(join(home, CHARTER_FILE), "# My own charter\n", "utf8"),
    });
    expect(await read(home, CHARTER_FILE)).toBe("# My own charter\n");
    expect(state).toMatchObject({ edited: true });
  });

  it("writes the comparison on request only when there is something to compare", async () => {
    const home = await tempHome();
    await syncCharter(home, V1);
    expect(await writeNewCharter(home, V1)).toBe(false);
    expect(await exists(join(home, NEW_CHARTER_FILE))).toBe(false);
    await editCopy(home, "Mine.");
    expect(await writeNewCharter(home, V2)).toBe(true);
    expect(await read(home, NEW_CHARTER_FILE)).toContain("Version two.");
  });
});

describe("prepareHome and the charter", () => {
  it("renders AGENTS.md from the captain's copy, placeholders filled and notes left out", async () => {
    const home = await tempHome();
    await prepareHome(home, homeConfig);
    const agents = await read(home, "AGENTS.md");
    expect(agents).toMatch(/^<!-- Written by the FirstMate plugin for bb from data\/charter\.md/);
    expect(agents).toContain(`Your home is \`${home}\``);
    expect(agents).not.toContain("firstmate-charter");
    expect(fingerprint(await read(home, CHARTER_FILE))).toBe(fingerprint(await readTemplate(TEMPLATES.charter)));
    // Pinned so a charter change is deliberate: every untouched home follows it, and every edited one is
    // offered it as charter.new.md. dab8203ddd18566b is the charter telling the first mate what to do when
    // bb cuts a crewmate's work short (host loss, a daemon restart, a failed setup, an undelivered message)
    // and to check the log for a stop by hand, which sends nothing, before any nudge, resend or relaunch;
    // dda507f48da7647d held any work a relayed message starts,
    // steers or relaunches for the captain's word to merge; 022869ca9102c7d4 held only work it started, over
    // `+yolo` and standing orders; 7ac1042b58fb4a85 had it saying a message relayed by `tell` (as
    // `/fm` sends) opens with `Relayed by bb firstmate-crew tell` and never stands in for the captain's word;
    // a5a689fdd3a12e27 had it naming the CLI `bb firstmate-crew` after the plugin
    // id changed; 83b2b65bf38bb8e0 had it saying bb also wakes the first mate
    // when a crewmate needs attention (a permission or a question); a89e672c1e7d45f9 had the relaunch
    // command carrying --title and the crew list saying archived children are included; 62c1c091a39506bd told the first
    // mate to always title its crew; 79b5a4bc6315ef40 the charter rewritten for bb; 09fd534b24db4e75 was Paseo's text
    // with only its placeholders renamed, e0b749cb695c5df6 the charter as it moved into templates/, and
    // 8b6df21d082df6e6 Paseo's before {{crewModeRule}} became {{crewReasoningRule}}.
    expect(fingerprint(await readTemplate(TEMPLATES.charter))).toBe("dab8203ddd18566b");

    await editCopy(home, "# My first mate\n\n<!-- a note to myself -->\nYour home is {{home}}; keep it tidy.");
    await prepareHome(home, homeConfig);
    const edited = await read(home, "AGENTS.md");
    expect(edited).toContain(`Your home is ${home}; keep it tidy.`);
    expect(edited).not.toContain("a note to myself");
    expect(edited).not.toContain("## 1. Hard rules");
  });
});
