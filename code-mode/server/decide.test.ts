import { describe, expect, it, vi } from "vitest";

import type { CodeModeRecord } from "../shared/record";
import { decide, modelGuard, requireWrapper, type DecisionFacts } from "./decide";

const ON: CodeModeRecord = { codeMode: "on", reason: "test", decidedAt: 1 };
const OFF: CodeModeRecord = { codeMode: "off", reason: "test", decidedAt: 1 };

function facts(overrides: Partial<DecisionFacts> = {}): DecisionFacts {
  return {
    fork: null,
    explicit: null,
    spawned: false,
    spawnedRule: "project-default",
    parentRecord: null,
    projectDefault: false,
    hostAllowed: true,
    hostName: "MacMini",
    model: "claude-opus-5-5",
    ...overrides,
  };
}

describe("decide", () => {
  it("leaves a thread off by default", () => {
    expect(decide(facts())).toMatchObject({ kind: "record", codeMode: "off" });
  });

  it("turns it on from Send in Code Mode", () => {
    expect(decide(facts({ explicit: true }))).toEqual({ kind: "record", codeMode: "on", reason: "chosen in the Send menu" });
  });

  it("refuses Send in Code Mode on a machine that is not turned on, saying so", () => {
    const decision = decide(facts({ explicit: true, hostAllowed: false }));
    expect(decision.kind).toBe("reject");
    expect(decision.kind === "reject" && decision.message).toContain("Code Mode is off on MacMini");
  });

  it("refuses Send in Code Mode on a model without Code Mode, naming it", () => {
    const decision = decide(facts({ explicit: true, model: "claude-opus-5" }));
    expect(decision.kind === "reject" && decision.message).toContain("claude-opus-5");
  });

  it("lets an unknown model through, for Claude Code to decide", () => {
    expect(decide(facts({ explicit: true, model: null }))).toMatchObject({ codeMode: "on" });
    expect(decide(facts({ explicit: true, model: "opus" }))).toMatchObject({ codeMode: "on" });
  });

  it("follows the project's default for a thread a person starts", () => {
    expect(decide(facts({ projectDefault: true }))).toMatchObject({ codeMode: "on", reason: "the project's default" });
  });

  it("leaves a default-on thread off on a machine that is not turned on, or a model without Code Mode", () => {
    expect(decide(facts({ projectDefault: true, hostAllowed: false }))).toMatchObject({ codeMode: "off" });
    expect(decide(facts({ projectDefault: true, model: "claude-sonnet-5" }))).toMatchObject({ codeMode: "off" });
  });

  it("applies the spawned-threads rule to threads agents and plugins start", () => {
    expect(decide(facts({ spawned: true, projectDefault: true }))).toMatchObject({ codeMode: "on" });
    expect(decide(facts({ spawned: true, projectDefault: true, spawnedRule: "off" }))).toMatchObject({ codeMode: "off" });
    expect(decide(facts({ spawned: true, spawnedRule: "parent", parentRecord: ON }))).toMatchObject({ codeMode: "on", reason: "same as the thread that started it" });
    expect(decide(facts({ spawned: true, spawnedRule: "parent", parentRecord: OFF, projectDefault: true }))).toMatchObject({ codeMode: "off" });
    expect(decide(facts({ spawned: true, spawnedRule: "parent", parentRecord: null }))).toMatchObject({ codeMode: "off" });
  });

  it("gives a fork its source's choice, whatever the settings say", () => {
    expect(decide(facts({ fork: { sourceRecord: ON }, hostAllowed: false, explicit: false }))).toMatchObject({ codeMode: "on" });
    expect(decide(facts({ fork: { sourceRecord: OFF }, projectDefault: true, explicit: true }))).toMatchObject({ codeMode: "off" });
    expect(decide(facts({ fork: { sourceRecord: null }, projectDefault: true }))).toMatchObject({ codeMode: "off" });
  });
});

describe("modelGuard", () => {
  it("refuses moving a Code Mode thread to a model without Code Mode", () => {
    const message = modelGuard(ON, "claude-opus-5");
    expect(message).toContain("runs in Code Mode");
    expect(message).toContain("claude-opus-5");
  });

  it("lets everything else through", () => {
    expect(modelGuard(ON, "claude-sonnet-5-5")).toBeNull();
    expect(modelGuard(ON, null)).toBeNull();
    expect(modelGuard(OFF, "claude-opus-4-8")).toBeNull();
    expect(modelGuard(null, "claude-opus-4-8")).toBeNull();
  });
});

describe("requireWrapper", () => {
  const notReady = async () => ({ ok: false as const, reason: "This machine's bb has no Node the wrapper can use." });
  const ready = async () => ({ ok: true as const });

  it("refuses an explicit Code Mode send where the wrapper isn't ready, naming the machine and the reason", async () => {
    const decision = await requireWrapper(decide(facts({ explicit: true })), facts({ explicit: true }), notReady);
    expect(decision.kind).toBe("reject");
    expect(decision.kind === "reject" && decision.message).toContain("Code Mode's wrapper isn't ready on MacMini: This machine's bb has no Node");
  });

  it("leaves a default-on thread off there instead", async () => {
    const decision = await requireWrapper(decide(facts({ projectDefault: true })), facts({ projectDefault: true }), notReady);
    expect(decision).toMatchObject({ kind: "record", codeMode: "off" });
  });

  it("asks nothing for an off decision or a fork, and keeps a ready one", async () => {
    const asked = vi.fn(notReady);
    expect(await requireWrapper(decide(facts()), facts(), asked)).toMatchObject({ codeMode: "off" });
    const fork = facts({ fork: { sourceRecord: ON } });
    expect(await requireWrapper(decide(fork), fork, asked)).toMatchObject({ codeMode: "on" });
    expect(asked).not.toHaveBeenCalled();
    expect(await requireWrapper(decide(facts({ explicit: true })), facts({ explicit: true }), ready)).toMatchObject({ codeMode: "on" });
  });
});
