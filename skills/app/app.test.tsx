// @vitest-environment jsdom
/**
 * The slots render, list a thread's skills in precedence order, read one and
 * invoke it by sending `/name args` to the thread. A throwing slot shows as a
 * "plugin crashed" chip in bb, so a render here is the cheapest check that none
 * of them throw.
 */
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginAppBuilder, PluginCommandRegistration } from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RpcContract } from "../shared/contract";
import type { SkillDocument, SkillEntry, SkillList } from "../shared/skills";
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

function sentMessages() {
  const sent: unknown[] = [];
  return {
    sent,
    sdk: {
      threads: {
        send: async (args: unknown) => {
          sent.push(args);
          return { delivery: "sent" } as never;
        },
      },
    },
  };
}

function renderPanel(options: { list?: () => SkillList; send?: ReturnType<typeof sentMessages> } = {}) {
  const send = options.send ?? sentMessages();
  const result = renderSlot<{ threadId: string; params: null }, RpcContract>(
    { component: SkillsPanel },
    { threadId: "thr_example", params: null },
    { rpc: { ...rpc, list: options.list ?? rpc.list }, sdk: send.sdk },
  );
  return { ...result, sent: send.sent };
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

  it("reads a skill, with its path and its body, and its images turned into links", async () => {
    const { inspection } = renderPanel();
    fireEvent.click(await screen.findByText("tidy-imports"));
    expect(await screen.findByText("/skills/tidy-imports/SKILL.md")).toBeTruthy();
    expect(inspection.rpcCalls.at(-1)).toEqual({ method: "read", input: { threadId: "thr_example", skillId: "project:/skills:tidy-imports" } });
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
  });

  it("invokes a skill with its arguments, queued behind a running turn, then goes to the thread", async () => {
    const { sent, inspection } = renderPanel();
    fireEvent.click(await screen.findByText("tidy-imports"));
    fireEvent.change(await screen.findByLabelText("Arguments for /tidy-imports"), { target: { value: "  src only " } });
    fireEvent.click(screen.getByRole("button", { name: "Invoke /tidy-imports" }));

    await waitFor(() => expect(inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_example" }]));
    expect(sent).toEqual([
      {
        threadId: "thr_example",
        mode: "queue-if-active",
        input: [{ type: "text", text: "/tidy-imports src only", mentions: [] }],
      },
    ]);
    // Back on the list, not on the detail of a skill already run.
    expect(await screen.findByLabelText("Search skills")).toBeTruthy();
  });

  it("sends once however often Invoke is pressed while a send is in flight", async () => {
    const sent: unknown[] = [];
    let answer: () => void = () => {};
    const slow = {
      sent,
      sdk: {
        threads: {
          send: (args: unknown) => {
            sent.push(args);
            return new Promise((resolve) => {
              answer = () => resolve({ delivery: "sent" });
            }) as never;
          },
        },
      },
    };
    renderPanel({ send: slow });
    fireEvent.click(await screen.findByText("deploy"));
    const button = await screen.findByRole("button", { name: "Invoke /deploy" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    answer();
    await waitFor(() => expect(sent).toHaveLength(1));
  });

  it("keeps the detail open with the error when the send fails", async () => {
    const failing = {
      sent: [] as unknown[],
      sdk: {
        threads: {
          send: async () => {
            throw new Error("thread is archived");
          },
        },
      },
    };
    const { inspection } = renderPanel({ send: failing });
    fireEvent.click(await screen.findByText("deploy"));
    fireEvent.click(await screen.findByRole("button", { name: "Invoke /deploy" }));
    expect(await screen.findByText("thread is archived")).toBeTruthy();
    expect(inspection.navigateCalls).toEqual([]);
  });

  it("offers no Invoke for a model-invoked-only skill", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("helper-only"));
    expect(await screen.findByText(/model-invoked only/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Invoke/ })).toBeNull();
  });

  it("invokes a reported entry without reading anything", async () => {
    const { sent, inspection } = renderPanel();
    fireEvent.click(await screen.findByText("explain"));
    expect(screen.getByText("[file]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Invoke /explain" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(inspection.rpcCalls.map((call) => call.method)).toEqual(["list"]);
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

  it("opens the browser over the composer and closes it after an invoke", async () => {
    const send = sentMessages();
    const { inspection } = renderSlot<object, RpcContract>({ component: SkillsComposerButton }, {}, {
      rpc,
      sdk: send.sdk,
      composer: { scope: { kind: "thread", threadId: "thr_example" } },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Skills: 6" }));
    const popover = await screen.findByRole("dialog");
    // The popover keeps to running a skill; the path stays in the panel.
    fireEvent.click(await within(popover).findByText("deploy"));
    await within(popover).findByText("Description for deploy");
    expect(within(popover).queryByRole("button", { name: "Copy path" })).toBeNull();
    fireEvent.click(within(popover).getByRole("button", { name: "Invoke /deploy" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(send.sent).toHaveLength(1);
    expect(inspection.navigateCalls).toEqual([]);
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
});
