import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComposerFactsState } from "./composer-facts";
import { resetComposerFacts, setComposerFacts } from "./composer-facts";
import { selectedHostId, sendInBlocked, sendInCodeMode, sendWithoutCodeMode, SEND_WITHOUT_DATA, startsInCodeModeByDefault } from "./send-menu";

vi.mock("@get-bb/plugin-sdk/app", () => ({}));

const MINI = "host_mini";
const WORK_LAPTOP = "host_work_laptop";

function facts(overrides: Partial<ComposerFactsState> = {}): ComposerFactsState {
  return {
    config: { projectNames: { "Acme Web": true }, hosts: { [MINI]: true } },
    statuses: { [MINI]: { ok: true, message: "Wrapper ready" } },
    hostNames: { [MINI]: "MacMini", [WORK_LAPTOP]: "Work Laptop" },
    projectNames: { proj_acme: "Acme Web", proj_ios: "iOS-Doximity" },
    ...overrides,
  };
}

const onMachine = (hostId: string, extra: Record<string, unknown> = {}) =>
  ({ providerId: "claude-code", model: "claude-opus-5-5", environment: { type: "host", hostId, workspace: { type: "managed-worktree" } }, ...extra }) as never;

const NEW_THREAD = { kind: "new-thread", projectId: null } as const;

afterEach(resetComposerFacts);

describe("the machine the composer picked", () => {
  it("comes from a host or a machine-provider environment", () => {
    expect(selectedHostId(onMachine(MINI))).toBe(MINI);
    expect(selectedHostId({ environment: { type: "provider", environmentProviderId: "x", machine: { type: "existing", hostId: WORK_LAPTOP }, inputs: null } } as never)).toBe(WORK_LAPTOP);
    expect(selectedHostId({ environment: { type: "project-default" } } as never)).toBeNull();
    expect(selectedHostId(null)).toBeNull();
  });
});

describe("Send in Code Mode", () => {
  it("is greyed out on a machine where Code Mode is off, naming it", () => {
    expect(sendInBlocked(onMachine(WORK_LAPTOP), facts())).toBe("Code Mode is off on Work Laptop");
  });

  it("is greyed out where the wrapper isn't ready", () => {
    const state = facts({ config: { projectNames: {}, hosts: { [WORK_LAPTOP]: true } }, statuses: { [WORK_LAPTOP]: { ok: false, message: "This machine's bb has no Node." } } });
    expect(sendInBlocked(onMachine(WORK_LAPTOP), state)).toBe("Code Mode's wrapper isn't ready on Work Laptop: This machine's bb has no Node");
  });

  it("is greyed out for another agent and a model without Code Mode", () => {
    expect(sendInBlocked({ providerId: "codex" } as never, facts())).toContain("Claude Code");
    expect(sendInBlocked(onMachine(MINI, { model: "claude-opus-5" }), facts())).toContain("only works with");
  });

  it("is offered on a machine that is on, whatever the project's default", () => {
    expect(sendInBlocked(onMachine(MINI, { projectId: "proj_ios" }), facts())).toBeNull();
    expect(sendInBlocked(onMachine(MINI, { projectId: "proj_acme" }), facts())).toBeNull();
  });

  it("leaves a machine it can't name, or switches not loaded yet, to the dispatch hook", () => {
    expect(sendInBlocked({ providerId: "claude-code", environment: { type: "project-default" } } as never, facts())).toBeNull();
    expect(sendInBlocked(onMachine(WORK_LAPTOP), facts({ config: null }))).toBeNull();
  });

  it("follows the machine picker as it changes", () => {
    setComposerFacts(facts());
    const composer = { selection: onMachine(MINI), scope: NEW_THREAD } as never as { selection: unknown };
    expect((sendInCodeMode.disabled as (c: unknown) => boolean)(composer)).toBe(false);
    composer.selection = onMachine(WORK_LAPTOP);
    expect((sendInCodeMode.disabled as (c: unknown) => boolean)(composer)).toBe(true);
  });
});

describe("Send without Code Mode", () => {
  it("is offered only when the project and the machine are on", () => {
    expect(startsInCodeModeByDefault(onMachine(MINI, { projectId: "proj_acme" }), NEW_THREAD, facts())).toBe(true);
    expect(startsInCodeModeByDefault(onMachine(MINI, { projectId: "proj_ios" }), NEW_THREAD, facts())).toBe(false);
    expect(startsInCodeModeByDefault(onMachine(WORK_LAPTOP, { projectId: "proj_acme" }), NEW_THREAD, facts())).toBe(false);
    expect(startsInCodeModeByDefault(onMachine(MINI, { projectId: "proj_acme", model: "claude-opus-5" }), NEW_THREAD, facts())).toBe(false);
  });

  it("reads the project from the composer's scope when the picker has none", () => {
    expect(startsInCodeModeByDefault(onMachine(MINI), { kind: "new-thread", projectId: "proj_acme" }, facts())).toBe(true);
  });

  it("greys out and lights up as the pickers change, and sends the opt-out", async () => {
    setComposerFacts(facts());
    const disabled = sendWithoutCodeMode.disabled as (c: unknown) => boolean;
    expect(disabled({ selection: onMachine(MINI, { projectId: "proj_acme" }), scope: NEW_THREAD })).toBe(false);
    expect(disabled({ selection: onMachine(MINI, { projectId: "proj_ios" }), scope: NEW_THREAD })).toBe(true);
    const submit = vi.fn(async () => undefined);
    await sendWithoutCodeMode.run({ composer: { submit } as never });
    expect(submit).toHaveBeenCalledWith({ experimental_data: SEND_WITHOUT_DATA });
  });
});
