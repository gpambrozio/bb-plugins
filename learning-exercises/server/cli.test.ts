import { describe, expect, it } from "vitest";

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

import { decodeForm, decodeQuestion, FORM_MAX_BYTES, learningCli, QUESTION_MAX_BYTES } from "./cli";
import { OrientationService } from "./orientation";
import type { SessionService } from "./sessions";
import { FakePorts, thread } from "./testing/fake-ports";
import { memoryOrientationStore, settingsWith } from "./testing/store";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("decodeQuestion", () => {
  it("decodes UTF-8 and drops one heredoc newline", () => {
    expect(decodeQuestion(b64("What does `x` do? “quotes” and 'single'\n"))).toBe("What does `x` do? “quotes” and 'single'");
    expect(decodeQuestion(b64("Two lines\nhere\n\n"))).toBe("Two lines\nhere\n");
  });

  it("refuses what is not base64, empty, too long, or not UTF-8", () => {
    expect(() => decodeQuestion("not base64!")).toThrow("not valid base64");
    expect(() => decodeQuestion("")).toThrow("not valid base64");
    expect(() => decodeQuestion(b64("x".repeat(QUESTION_MAX_BYTES + 1)))).toThrow("longer than");
    expect(() => decodeQuestion(Buffer.from([0xff, 0xfe, 0xfd]).toString("base64"))).toThrow("UTF-8");
  });
});

describe("decodeForm", () => {
  it("decodes base64 JSON, leaving its checks to the session", () => {
    expect(decodeForm(b64('{"items": [{"kind": "yes-no", "id": "a", "label": "A?"}]}\n'))).toEqual({ items: [{ kind: "yes-no", id: "a", label: "A?" }] });
    expect(decodeForm(b64('{"items": "not a form"}'))).toEqual({ items: "not a form" });
  });

  it("refuses what is not base64, too long, or not JSON", () => {
    expect(() => decodeForm("{not base64}")).toThrow("--form-base64 is not valid base64");
    expect(() => decodeForm(b64("x".repeat(FORM_MAX_BYTES + 1)))).toThrow("answer form is longer than");
    expect(() => decodeForm(b64("{items: []}"))).toThrow("--form-base64 is not JSON");
  });
});

describe("bb learning orient", () => {
  const BUILDER = "thr_spawn1";

  /** A builder thread bound to a walkthrough build (the fake ports name the first spawn `thr_spawn1`). */
  async function run(args: string[], threadId = "thr_other") {
    const { bb, harness } = createFakePluginHost({ pluginId: "learning-exercises" });
    const ports = new FakePorts();
    ports.threads.set("thr_src", thread({ id: "thr_src" }));
    const { orientations } = memoryOrientationStore();
    const service = new OrientationService(ports, orientations, () => settingsWith());
    await service.reconcile();
    await service.start({ sourceThreadId: "thr_src", depth: "walkthrough" });
    bb.cli.register(learningCli({} as SessionService, service));
    return harness.runCli(args, { threadId });
  }

  it("listing from a thread that is not building is refused with the service's text", async () => {
    const result = await run(["orient", "listing", "--path", "a.ts", "--lines", "40-41", "--caption-base64", b64("x")]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not building an orientation");
  });

  it("listing with a bad --lines from the builder exits with the lines refusal", async () => {
    const result = await run(["orient", "listing", "--path", "a.ts", "--lines", "nope", "--caption-base64", b64("x")], BUILDER);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('"nope" is not a line range');
  });

  it("chapter from the builder succeeds", async () => {
    const result = await run(["orient", "chapter", "--title-base64", b64("Parsing")], BUILDER);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(1);
  });

  it("summary refuses invalid base64 and non-JSON with its message", async () => {
    for (const [value, text] of [["!!!", "not valid base64"], [b64("not json"), "is not JSON"]] as const) {
      const result = await run(["orient", "summary", "--summary-base64", value]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(text);
    }
  });
});
