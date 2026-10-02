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
import type { ComposerMention, JsonValue, PluginAppBuilder, PluginCommandRegistration } from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RpcContract } from "../shared/contract";
import type { SkillDocument, SkillEntry, SkillList } from "../shared/skills";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";

import { SkillsComposerButton } from "./composer-button";
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
    skills: [{ name: "explain", description: "Explains code", argumentHint: "[file]" }],
    commands: [{ name: "clear", description: "Starts fresh", argumentHint: "" }],
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
  it("adds a thread panel, a thread-composer button and a command that opens the panel", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.threadPanelActions.map((action) => action.id)).toEqual(["skills"]);
    expect(app.composerCustomizations).toEqual([
      expect.objectContaining({ id: "skills", scopes: ["thread"], actions: [expect.objectContaining({ id: "skills" })] }),
    ]);
    // The harness captures slots but not commands; the setup runs again
    // against a builder that keeps only those.
    const commands: PluginCommandRegistration[] = [];
    const ignore = new Proxy({}, { get: () => () => {} });
    const definition = (await import("../app")).default;
    definition.setup({
      slots: ignore,
      composer: ignore,
      contentScripts: ignore,
      experimental_icons: ignore,
      experimental_sidebarFooter: ignore,
      commands: { register: (registration: PluginCommandRegistration) => commands.push(registration) },
    } as unknown as PluginAppBuilder);
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
    expect(inspection.composer.focusCount).toBe(1);
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
    expect(mentions).toEqual([{ ...mention, from: 22, to: 30 }]);
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
    expect(inspection.rpcCalls.map((call) => call.method)).toEqual(["list"]);
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

describe("the composer button", () => {
  it("counts everything the browser lists, once the list answers", async () => {
    renderSlot<object, RpcContract>({ component: SkillsComposerButton }, {}, {
      rpc,
      composer: { scope: { kind: "thread", threadId: "thr_example" } },
    });
    expect(await screen.findByRole("button", { name: "Skills: 6" })).toBeTruthy();
  });

  it("draws nothing outside a thread's own composer", () => {
    const { container } = renderSlot<object, RpcContract>({ component: SkillsComposerButton }, {}, {
      rpc,
      composer: { scope: { kind: "new-thread", projectId: "proj_example" } },
    });
    expect(container.textContent).toBe("");
  });

  it("adds the command to this composer, closes the popover and focuses the composer", async () => {
    const { inspection } = renderSlot<object, RpcContract>({ component: SkillsComposerButton }, {}, {
      rpc,
      composer: { scope: { kind: "thread", threadId: "thr_example" } },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Skills: 6" }));
    const popover = await screen.findByRole("dialog");
    fireEvent.click(await within(popover).findByText("deploy"));
    await within(popover).findByText("Description for deploy");
    // The popover keeps to using a skill; the path stays in the panel.
    expect(within(popover).queryByRole("button", { name: "Copy path" })).toBeNull();
    fireEvent.click(within(popover).getByRole("button", { name: "Add to chat" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(inspection.composer.text).toBe("/deploy ");
    expect(inspection.composer.focusCount).toBeGreaterThanOrEqual(1);
    expect(inspection.navigateCalls).toEqual([]);
    expect(inspection.sdkCalls).toEqual([]);
  });

  // On a narrow window the popover is a drawer, which hands focus back to the
  // button that opened it as it closes. The composer must take it after that,
  // or the cursor ends up on the Skills button instead of after the command.
  it("gives the composer focus after the narrow-window drawer has handed it back to the button", async () => {
    function CompactButton() {
      return (
        <CompactViewportOverrideProvider isCompactViewport>
          <SkillsComposerButton />
        </CompactViewportOverrideProvider>
      );
    }
    const { inspection } = renderSlot<object, RpcContract>({ component: CompactButton }, {}, {
      rpc,
      composer: { scope: { kind: "thread", threadId: "thr_example" } },
    });
    const trigger = await screen.findByRole("button", { name: "Skills: 6" });
    let focusCountWhenButtonRefocused: number | null = null;
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByText("deploy", {}, { timeout: 2000 }));
    trigger.addEventListener("focus", () => {
      focusCountWhenButtonRefocused = inspection.composer.focusCount;
    });
    fireEvent.click(await screen.findByRole("button", { name: "Add to chat" }));

    expect(inspection.composer.text).toBe("/deploy ");
    await waitFor(() => expect(focusCountWhenButtonRefocused).not.toBeNull());
    await waitFor(() => expect(inspection.composer.focusCount).toBeGreaterThan(focusCountWhenButtonRefocused!), {
      timeout: 2000,
    });
  });

  it("opens the panel from the popover", async () => {
    const { inspection } = renderSlot<object, RpcContract>({ component: SkillsComposerButton }, {}, {
      rpc,
      composer: { scope: { kind: "thread", threadId: "thr_example" } },
      openThreadPanel: () => true,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Skills: 6" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open in panel" }));
    expect(inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "skills" } }]);
  });

  it("opens the panel on the skill the popover is showing", async () => {
    const { inspection } = renderSlot<object, RpcContract>({ component: SkillsComposerButton }, {}, {
      rpc,
      composer: { scope: { kind: "thread", threadId: "thr_example" } },
      openThreadPanel: () => true,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Skills: 6" }));
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

  it("opens the panel on a reported entry the popover is showing", async () => {
    const { inspection } = renderSlot<object, RpcContract>({ component: SkillsComposerButton }, {}, {
      rpc,
      composer: { scope: { kind: "thread", threadId: "thr_example" } },
      openThreadPanel: () => true,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Skills: 6" }));
    fireEvent.click(await screen.findByText("explain"));
    fireEvent.click(await screen.findByRole("button", { name: "Open in panel" }));
    expect(inspection.navigateCalls).toEqual([
      {
        method: "openThreadPanel",
        options: { actionId: "skills", title: "Skills: explain", params: { skill: { kind: "reported", name: "explain" } } },
      },
    ]);
  });

  it("opens the panel on the list again once the popover is back on its list", async () => {
    const { inspection } = renderSlot<object, RpcContract>({ component: SkillsComposerButton }, {}, {
      rpc,
      composer: { scope: { kind: "thread", threadId: "thr_example" } },
      openThreadPanel: () => true,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Skills: 6" }));
    fireEvent.click(await screen.findByText("deploy"));
    fireEvent.click(await screen.findByRole("button", { name: "← All skills" }));
    await screen.findByLabelText("Search skills");
    fireEvent.click(screen.getByRole("button", { name: "Open in panel" }));
    expect(inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "skills" } }]);
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
