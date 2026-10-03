// @vitest-environment jsdom
/**
 * The slots render, list a thread's skills in precedence order, read one and
 * add its command to the thread's message box — never sending anything: no
 * slot here is given a `useSdk()` fake, so a send would throw. A throwing slot
 * shows as a "plugin crashed" chip in bb, so a render here is the cheapest
 * check that none of them throw.
 */
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  type ComposerMention,
  type ExperimentalComposerCommandRegistration,
  type JsonValue,
  type PluginAppBuilder,
  type PluginCommandRegistration,
  useComposer,
} from "@get-bb/plugin-sdk/app";
import { type ComponentType, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RpcContract } from "../shared/contract";
import type { SkillDocument, SkillEntry, SkillList } from "../shared/skills";

import { SkillsComposerButton } from "./composer-button";
import { SkillsPopup } from "./composer-popup";
import { SkillsPanel } from "./panel";

beforeEach(() => {
  // jsdom lays nothing out, so it has no scrolling to do.
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

function entry(name: string, kind: SkillEntry["source"]["kind"], label: string, extra: Partial<SkillEntry> = {}): SkillEntry {
  return {
    id: `${kind}:/skills:${name}`,
    name,
    description: `Description for ${name}`,
    source: { kind, label, dir: "/skills" },
    path: `/skills/${name}/SKILL.md`,
    userInvocable: true,
    status: "discovered",
    ...extra,
  };
}

const LIST: SkillList = {
  provider: "claude-code",
  scanned: true,
  cwd: "/work/example",
  skills: [
    entry("bb-helper", "bb", "bb plugin · example-plugin"),
    entry("deploy", "personal", "Personal"),
    entry("helper-only", "project", "Project", { userInvocable: false }),
    entry("tidy-imports", "project", "Project"),
  ],
  reported: {
    error: null,
    skills: [{ name: "explain", description: "Explains code", argumentHint: "[file]", origin: "builtin" }],
    commands: [{ name: "clear", description: "Starts fresh", argumentHint: "", origin: "builtin" }],
  },
};

function documentFor(skillId: string): SkillDocument {
  const skill = LIST.skills.find((candidate) => candidate.id === skillId);
  if (skill === undefined) throw new Error(`Skill not available: ${skillId}`);
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    body: `# ${skill.name}\n\nDo the thing. ![pixel](https://example.com/p.gif)\n`,
  };
}

const rpc = {
  list: () => LIST,
  read: ({ skillId }: { skillId: string }) => documentFor(skillId),
};

function renderPanel(
  options: {
    list?: () => SkillList;
    composer?: { text?: string; mentions?: readonly ComposerMention[]; scope?: { kind: "thread"; threadId: string } };
    params?: JsonValue;
  } = {},
) {
  return renderSlot<{ threadId: string; params: JsonValue }, RpcContract>(
    { component: SkillsPanel },
    { threadId: "thr_example", params: options.params ?? null },
    {
      rpc: { ...rpc, list: options.list ?? rpc.list },
      composer: { scope: { kind: "thread", threadId: "thr_example" }, ...options.composer },
    },
  );
}

describe("registrations", () => {
  it("adds a thread panel, a thread-composer button with its popup, and commands", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.threadPanelActions.map((action) => action.id)).toEqual(["skills"]);
    expect(app.composerCustomizations).toEqual([
      expect.objectContaining({
        id: "skills",
        scopes: ["thread"],
        actions: [expect.objectContaining({ id: "skills" })],
        experimental_popups: [expect.objectContaining({ id: "skills", label: "Skills" })],
      }),
    ]);
    // The harness captures slots but not commands; the setup runs again
    // against a builder that keeps only those.
    const commands: PluginCommandRegistration[] = [];
    const composerCommands: ExperimentalComposerCommandRegistration[] = [];
    const ignore = new Proxy({}, { get: () => () => {} });
    const definition = (await import("../app")).default;
    definition.setup({
      slots: ignore,
      composer: {
        customize: () => {},
        experimental_registerCommand: (registration: ExperimentalComposerCommandRegistration) =>
          composerCommands.push(registration),
      },
      contentScripts: ignore,
      experimental_icons: ignore,
      experimental_sidebarFooter: ignore,
      commands: { register: (registration: PluginCommandRegistration) => commands.push(registration) },
    } as unknown as PluginAppBuilder);
    expect(composerCommands.map(({ id, title, defaultShortcut }) => ({ id, title, defaultShortcut }))).toEqual([
      { id: "browse", title: "Skills: browse this thread's skills", defaultShortcut: undefined },
    ]);
    // It toggles the popup in whichever composer runs it.
    let open = false;
    const composer = {
      experimental_openPopup: (id: string) => (open = id === "skills"),
      experimental_closePopup: () => {
        const wasOpen = open;
        open = false;
        return wasOpen;
      },
    } as unknown as Parameters<ExperimentalComposerCommandRegistration["run"]>[0]["composer"];
    await composerCommands[0]?.run({ composer });
    expect(open).toBe(true);
    await composerCommands[0]?.run({ composer });
    expect(open).toBe(false);
    expect(commands.map((registration) => registration.id)).toEqual(["open"]);
    const [command] = commands;
    expect(command?.isAvailable?.({ threadId: null, projectId: null, openPanel: () => true })).toBe(false);
    const opened: unknown[] = [];
    await command?.run({
      threadId: "thr_example",
      projectId: null,
      openPanel: (options) => {
        opened.push(options);
        return true;
      },
    });
    expect(opened).toEqual([{ actionId: "skills" }]);
  });
});

describe("the panel", () => {
  it("groups skills by source in precedence order, then the reported ones", async () => {
    renderPanel();
    await screen.findByText("tidy-imports");
    const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["Project", "Personal", "bb plugin · example-plugin", "Built-in skills", "Built-in commands"]);
  });

  it("filters on name and description", async () => {
    renderPanel();
    fireEvent.change(await screen.findByLabelText("Search skills"), { target: { value: "explains" } });
    expect(screen.queryByText("tidy-imports")).toBeNull();
    expect(screen.getByText("explain")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search skills"), { target: { value: "nothing like it" } });
    expect(screen.getByText("No skills match that search.")).toBeTruthy();
  });

  it("says where entries come from for a provider whose files are not scanned", async () => {
    renderPanel({ list: () => ({ ...LIST, provider: "pi", scanned: false }) });
    expect(await screen.findByText(/only scanned for Claude Code, Codex and Hermes/)).toBeTruthy();
  });

  it("shows why the list could not be had", async () => {
    renderPanel({
      list: () => {
        throw new Error("This thread has no environment yet.");
      },
    });
    expect(await screen.findByText("This thread has no environment yet.")).toBeTruthy();
  });

  it("shows a reported-list error under its own heading, keeping the rest", async () => {
    renderPanel({ list: () => ({ ...LIST, reported: { error: "provider is not available", skills: [], commands: [] } }) });
    expect(await screen.findByText("provider is not available")).toBeTruthy();
    expect(screen.getByText("tidy-imports")).toBeTruthy();
  });

  it("reads a skill, with its path and its body", async () => {
    const { inspection } = renderPanel();
    fireEvent.click(await screen.findByText("tidy-imports"));
    expect(await screen.findByText("/skills/tidy-imports/SKILL.md")).toBeTruthy();
    expect(inspection.rpcCalls.at(-1)).toEqual({ method: "read", input: { threadId: "thr_example", skillId: "project:/skills:tidy-imports" } });
    // The harness renders Markdown as plain text, so whether images load is
    // checked on the parsed source, in markdown.test.ts.
    expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
  });

  it("adds the command to the thread's draft without sending, then goes to the thread", async () => {
    const { inspection } = renderPanel({ composer: { text: "look at auth.ts" } });
    fireEvent.click(await screen.findByText("tidy-imports"));
    fireEvent.click(await screen.findByRole("button", { name: "Add to chat" }));

    expect(inspection.composer.text).toBe("/tidy-imports look at auth.ts");
    // The pill bb's own / menu inserts for a skill from the workspace.
    expect(inspection.composer.draft.mentions).toEqual([
      {
        kind: "command",
        trigger: "/",
        name: "tidy-imports",
        source: "skill",
        origin: "project",
        argumentHint: null,
        label: "tidy-imports",
        from: 0,
        to: 13,
      },
    ]);
    expect(inspection.composer.focusCount).toBe(1);
    expect(inspection.composer.submits).toEqual([]);
    expect(inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_example" }]);
    expect(inspection.sdkCalls).toEqual([]);
    // Back on the list, not on the detail of a skill already added.
    expect(await screen.findByLabelText("Search skills")).toBeTruthy();
  });

  it("keeps the draft's mention pills on the text they sat on", async () => {
    const mention: ComposerMention = {
      kind: "path",
      path: "src/auth.ts",
      source: "workspace",
      entryKind: "file",
      label: "auth.ts",
      from: 8,
      to: 16,
    };
    const { inspection } = renderPanel({ composer: { text: "look at @auth.ts", mentions: [mention] } });
    fireEvent.click(await screen.findByText("tidy-imports"));
    fireEvent.click(await screen.findByRole("button", { name: "Add to chat" }));

    const { text, mentions } = inspection.composer.draft;
    expect(text).toBe("/tidy-imports look at @auth.ts");
    expect(mentions).toEqual([
      expect.objectContaining({ kind: "command", name: "tidy-imports", from: 0, to: 13 }),
      { ...mention, from: 22, to: 30 },
    ]);
    expect(text.slice(22, 30)).toBe("@auth.ts");
  });

  it("has no arguments field and no Invoke", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("deploy"));
    await screen.findByRole("button", { name: "Add to chat" });
    expect(screen.queryByRole("textbox", { name: /Arguments/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Invoke/ })).toBeNull();
  });

  it("adds a reported entry too, without reading anything, with a trailing space into an empty draft", async () => {
    const { inspection } = renderPanel();
    fireEvent.click(await screen.findByText("explain"));
    expect(screen.getByText("[file]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
    expect(inspection.composer.text).toBe("/explain ");
    expect(inspection.composer.draft.mentions).toEqual([
      {
        kind: "command",
        trigger: "/",
        name: "explain",
        source: "skill",
        origin: "builtin",
        argumentHint: "[file]",
        label: "explain",
        from: 0,
        to: 8,
      },
    ]);
    expect(inspection.rpcCalls.map((call) => call.method)).toEqual(["list"]);
  });

  it("adds a reported command as a command pill", async () => {
    const { inspection } = renderPanel();
    fireEvent.click(await screen.findByText("clear"));
    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
    expect(inspection.composer.draft.mentions).toEqual([
      expect.objectContaining({ kind: "command", name: "clear", source: "command", argumentHint: null }),
    ]);
  });

  it("replaces a command pill already at the start of the draft", async () => {
    const leading: ComposerMention = {
      kind: "command",
      trigger: "/",
      name: "explain",
      source: "skill",
      origin: "builtin",
      argumentHint: null,
      label: "explain",
      from: 0,
      to: 8,
    };
    const { inspection } = renderPanel({ composer: { text: "/explain the parser", mentions: [leading] } });
    fireEvent.click(await screen.findByText("deploy"));
    fireEvent.click(await screen.findByRole("button", { name: "Add to chat" }));
    expect(inspection.composer.draft.text).toBe("/deploy the parser");
    expect(inspection.composer.draft.mentions).toEqual([
      expect.objectContaining({ kind: "command", name: "deploy", from: 0, to: 7 }),
    ]);
  });

  it("offers no Add to chat when the composer it would write to is another thread's", async () => {
    renderPanel({ composer: { scope: { kind: "thread", threadId: "thr_other" } } });
    fireEvent.click(await screen.findByText("deploy"));
    await screen.findByText("Description for deploy");
    expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull();
  });

  it("offers no Add to chat for a model-invoked-only skill", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("helper-only"));
    expect(await screen.findByText(/model-invoked only/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull();
  });
});

/**
 * Stands in for bb's popup host: patches the composer handle every component in
 * this slot shares, so a test sees what the button and the popup ask of it.
 * The harness itself draws no popup.
 */
function popupHost(handle: ReturnType<typeof useComposer>) {
  const host = { open: false, opened: [] as string[], closes: 0 };
  handle.experimental_openPopup = (id: string) => {
    host.opened.push(id);
    host.open = true;
    return true;
  };
  handle.experimental_closePopup = () => {
    host.closes += 1;
    const wasOpen = host.open;
    host.open = false;
    return wasOpen;
  };
  return host;
}

function renderComposer(component: ComponentType, options: { openThreadPanel?: () => boolean } = {}) {
  let host: ReturnType<typeof popupHost> | undefined;
  function WithHost() {
    const composer = useComposer();
    host ??= popupHost(composer);
    const Component = component;
    return <Component />;
  }
  const rendered = renderSlot<object, RpcContract>({ component: WithHost }, {}, {
    rpc,
    composer: { scope: { kind: "thread", threadId: "thr_example" } },
    ...options,
  });
  return { ...rendered, host: () => host! };
}

describe("the composer button", () => {
  it("counts everything the browser lists, once the list answers", async () => {
    renderComposer(SkillsComposerButton);
    expect(await screen.findByRole("button", { name: "Skills: 6" })).toBeTruthy();
  });

  it("draws nothing outside a thread's own composer", () => {
    const { container } = renderSlot<object, RpcContract>({ component: SkillsComposerButton }, {}, {
      rpc,
      composer: { scope: { kind: "new-thread", projectId: "proj_example" } },
    });
    expect(container.textContent).toBe("");
  });

  // It sits in the composer's form, where a button with no type sends the message.
  it("is not a submit button", async () => {
    renderComposer(SkillsComposerButton);
    expect((await screen.findByRole("button", { name: "Skills: 6" })).getAttribute("type")).toBe("button");
  });

  it("opens bb's composer popup, and closes it again", async () => {
    const { host } = renderComposer(SkillsComposerButton);
    const button = await screen.findByRole("button", { name: "Skills: 6" });
    fireEvent.click(button);
    expect(host().opened).toEqual(["skills"]);
    expect(host().open).toBe(true);
    fireEvent.click(button);
    expect(host().open).toBe(false);
    expect(host().opened).toEqual(["skills"]);
  });
});

describe("the composer popup", () => {
  it("opens on the list the button already has, and its own scan updates the button's count", async () => {
    let answer = LIST;
    const { inspection } = renderSlot<object, RpcContract>(
      {
        component: function ButtonThenPopup() {
          const [open, setOpen] = useState(false);
          return (
            <>
              <SkillsComposerButton />
              <button type="button" onClick={() => setOpen(true)}>
                open the popup
              </button>
              {open ? <SkillsPopup /> : null}
            </>
          );
        },
      },
      {},
      { rpc: { ...rpc, list: () => answer }, composer: { scope: { kind: "thread", threadId: "thr_example" } } },
    );
    await screen.findByRole("button", { name: "Skills: 6" });
    answer = { ...LIST, skills: LIST.skills.slice(1) };
    fireEvent.click(screen.getByRole("button", { name: "open the popup" }));
    // No "Loading skills…" while the popup's own scan runs.
    expect(screen.queryByText("Loading skills…")).toBeNull();
    expect(screen.getByText("bb-helper")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Skills: 5" })).toBeTruthy();
    expect(screen.queryByText("bb-helper")).toBeNull();
    expect(inspection.rpcCalls.map((call) => call.method)).toEqual(["list", "list"]);
  });

  it("adds the skill's pill to this composer and closes, leaving the path to the panel", async () => {
    const { inspection, host } = renderComposer(SkillsPopup);
    host().open = true;
    fireEvent.click(await screen.findByText("deploy"));
    await screen.findByText("Description for deploy");
    expect(screen.queryByRole("button", { name: "Copy path" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));

    expect(inspection.composer.draft.text).toBe("/deploy ");
    expect(inspection.composer.draft.mentions).toEqual([
      {
        kind: "command",
        trigger: "/",
        name: "deploy",
        source: "skill",
        origin: "user",
        argumentHint: null,
        label: "deploy",
        from: 0,
        to: 7,
      },
    ]);
    expect(host().open).toBe(false);
    expect(inspection.composer.focusCount).toBeGreaterThanOrEqual(1);
    expect(inspection.navigateCalls).toEqual([]);
    expect(inspection.sdkCalls).toEqual([]);
    expect(inspection.composer.submits).toEqual([]);
  });

  // bb draws the popup inside the composer's form.
  it("has no submit button anywhere", async () => {
    renderComposer(SkillsPopup);
    fireEvent.click(await screen.findByText("deploy"));
    await screen.findByRole("button", { name: "Add to chat" });
    for (const button of screen.getAllByRole("button")) expect(button.getAttribute("type")).toBe("button");
  });

  // A press the form sees moves the focus to the editor, which closes the popup.
  it("keeps a press on its text from reaching the composer's form", async () => {
    let reached = 0;
    renderSlot<object, RpcContract>(
      {
        component: function InForm() {
          return (
            <div onMouseDown={() => (reached += 1)}>
              <SkillsPopup />
            </div>
          );
        },
      },
      {},
      { rpc, composer: { scope: { kind: "thread", threadId: "thr_example" } } },
    );
    fireEvent.mouseDown(await screen.findByText("Project"));
    fireEvent.mouseDown(screen.getByText("Skills"));
    expect(reached).toBe(0);
  });

  it("opens the panel, closing itself", async () => {
    const { inspection, host } = renderComposer(SkillsPopup, { openThreadPanel: () => true });
    host().open = true;
    await screen.findByText("deploy");
    fireEvent.click(screen.getByRole("button", { name: "Open in panel" }));
    expect(inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "skills" } }]);
    expect(host().open).toBe(false);
  });

  it("opens the panel on the skill it is showing", async () => {
    const { inspection } = renderComposer(SkillsPopup, { openThreadPanel: () => true });
    fireEvent.click(await screen.findByText("deploy"));
    await screen.findByText("Description for deploy");
    fireEvent.click(screen.getByRole("button", { name: "Open in panel" }));
    expect(inspection.navigateCalls).toEqual([
      {
        method: "openThreadPanel",
        options: {
          actionId: "skills",
          title: "Skills: deploy",
          params: { skill: { kind: "discovered", id: "personal:/skills:deploy" } },
        },
      },
    ]);
  });

  it("opens the panel on a reported entry it is showing", async () => {
    const { inspection } = renderComposer(SkillsPopup, { openThreadPanel: () => true });
    fireEvent.click(await screen.findByText("explain"));
    fireEvent.click(await screen.findByRole("button", { name: "Open in panel" }));
    expect(inspection.navigateCalls).toEqual([
      {
        method: "openThreadPanel",
        options: { actionId: "skills", title: "Skills: explain", params: { skill: { kind: "reported", name: "explain" } } },
      },
    ]);
  });

  it("opens the panel on the list again once it is back on its list", async () => {
    const { inspection } = renderComposer(SkillsPopup, { openThreadPanel: () => true });
    fireEvent.click(await screen.findByText("deploy"));
    fireEvent.click(await screen.findByRole("button", { name: "← All skills" }));
    await screen.findByLabelText("Search skills");
    fireEvent.click(screen.getByRole("button", { name: "Open in panel" }));
    expect(inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "skills" } }]);
  });

  it("draws nothing outside a thread's own composer", () => {
    const { container } = renderSlot<object, RpcContract>({ component: SkillsPopup }, {}, {
      rpc,
      composer: { scope: { kind: "new-thread", projectId: "proj_example" } },
    });
    expect(container.textContent).toBe("");
  });
});

describe("the panel opened on a skill", () => {
  it("shows that skill's detail straight away", async () => {
    const { inspection } = renderPanel({ params: { skill: { kind: "discovered", id: "personal:/skills:deploy" } } });
    expect(await screen.findByText("/skills/deploy/SKILL.md")).toBeTruthy();
    expect(inspection.rpcCalls.map((call) => call.method)).toContain("read");
    fireEvent.click(screen.getByRole("button", { name: "← All skills" }));
    expect(await screen.findByLabelText("Search skills")).toBeTruthy();
  });

  it("shows a reported entry's detail straight away", async () => {
    renderPanel({ params: { skill: { kind: "reported", name: "explain" } } });
    expect(await screen.findByText("Explains code")).toBeTruthy();
    expect(screen.getByText("[file]")).toBeTruthy();
  });

  it("opens on the list for params it does not recognise", async () => {
    renderPanel({ params: { skill: { kind: "other", path: "/etc/passwd" } } });
    expect(await screen.findByLabelText("Search skills")).toBeTruthy();
  });
});
