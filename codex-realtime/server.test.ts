/**
 * The whole server against the SDK's fake host, with a temporary Codex login.
 * Nothing here reads the real ~/.codex/auth.json or talks to OpenAI.
 */
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { createPlugin, parseAllowedPlugins } from "./server";
import { chatgptLogin, fakeToken, tempCodexHome } from "./testing/fake-login";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const HOUR = 3_600_000;
const VOICE_MODE = { experimental_caller: { kind: "plugin" as const, pluginId: "voice-mode" } };

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function load(options: { login?: string | null; settings?: Record<string, string> } = {}) {
  const codexHome = tempCodexHome();
  cleanup.push(codexHome.remove);
  if (options.login !== null) codexHome.write(options.login ?? chatgptLogin(fakeToken(NOW + 48 * HOUR)));
  const host = createFakePluginHost({ pluginId: "codex-realtime", settings: options.settings ?? {} });
  cleanup.push(() => host.harness.lifecycle.dispose());
  await createPlugin({ authPath: codexHome.authPath, now: () => NOW })(host.bb);
  const call = (input: unknown, caller = VOICE_MODE) => host.harness.behavior.callRpc("realtimeConnection", input, caller);
  return { host, codexHome, call };
}

function logText(host: Awaited<ReturnType<typeof load>>["host"]): string {
  return JSON.stringify(host.harness.inspection.logEntries);
}

describe("realtimeConnection", () => {
  it("is published for discovery, in the shape Voice Mode reads", async () => {
    const { host } = await load();
    expect(host.harness.inspection.registrations.experimental_publishedRpcMethods.map((m) => m.method)).toEqual(["realtimeConnection"]);
  });

  it("answers Voice Mode with the Realtime URL, the model and the ChatGPT token as bearer", async () => {
    const token = fakeToken(NOW + 48 * HOUR);
    const { call, host } = await load({ login: chatgptLogin(token) });
    await expect(call({})).resolves.toEqual({
      protocol: "openai-realtime",
      url: "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1",
      headers: { authorization: `Bearer ${token}` },
      model: "gpt-realtime-2.1",
    });
    for (const part of token.split(".")) expect(logText(host)).not.toContain(part);
    expect(host.harness.inspection.needsConfigurationMessages).toEqual([]);
  });

  it("uses the model setting, encoded into the URL, and the default when it is blank", async () => {
    const custom = await load({ settings: { model: "gpt-realtime-2.1-mini" } });
    await expect(custom.call({})).resolves.toMatchObject({
      url: "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini",
      model: "gpt-realtime-2.1-mini",
    });
    const odd = await load({ settings: { model: "a&b c" } });
    await expect(odd.call({})).resolves.toMatchObject({ url: "wss://api.openai.com/v1/realtime?model=a%26b+c" });
    const blank = await load({ settings: { model: "  " } });
    await expect(blank.call({})).resolves.toMatchObject({ model: "gpt-realtime-2.1" });
  });

  it("re-reads the login on refresh, and never writes it", async () => {
    const { call, codexHome } = await load();
    const renewed = chatgptLogin(fakeToken(NOW + 200 * HOUR, "b"));
    codexHome.write(renewed);
    const answer = (await call({ refresh: true })) as { headers: Record<string, string> };
    expect(answer.headers.authorization).toBe(`Bearer ${fakeToken(NOW + 200 * HOUR, "b")}`);
    expect(readFileSync(codexHome.authPath, "utf8")).toBe(renewed);
  });

  it("asks for configuration when there is no login, at load and when called", async () => {
    const { call, host, codexHome } = await load({ login: null });
    expect(host.harness.inspection.needsConfigurationMessages).toHaveLength(1);
    expect(host.harness.inspection.needsConfigurationMessages[0]).toContain("codex login");
    await expect(call({})).rejects.toThrow(/codex login/u);
    expect(host.harness.inspection.needsConfigurationMessages).toHaveLength(2);
    // A login made afterwards works at once, without a reload.
    codexHome.write(chatgptLogin(fakeToken(NOW + HOUR)));
    await expect(call({ refresh: true })).resolves.toMatchObject({ protocol: "openai-realtime" });
  });

  it("refuses an expired login with how to renew it, and leaves the file alone", async () => {
    const expired = chatgptLogin(fakeToken(NOW - HOUR));
    const { call, host, codexHome } = await load({ login: expired });
    await expect(call({})).rejects.toThrow(/expired.*codex/su);
    await expect(call({ refresh: true })).rejects.toThrow(/expired/u);
    expect(readFileSync(codexHome.authPath, "utf8")).toBe(expired);
    expect(host.harness.inspection.needsConfigurationMessages).toEqual([]);
  });

  it("refuses a malformed login", async () => {
    const { call } = await load({ login: "{ nope" });
    await expect(call({})).rejects.toThrow(/not valid JSON.*codex login/su);
  });

  it("never hands the token to the bb app or the CLI", async () => {
    const { call } = await load();
    await expect(call({}, { experimental_caller: { kind: "client" } } as never)).rejects.toThrow(/only to another plugin/u);
  });

  it("hands the token only to plugins on the allow list", async () => {
    const { call, host } = await load();
    const other = { experimental_caller: { kind: "plugin" as const, pluginId: "someone-else" } };
    await expect(call({}, other)).rejects.toThrow(/someone-else is not allowed/u);
    await host.harness.behavior.setSettings({ allowedPlugins: "voice-mode, someone-else" });
    await expect(call({}, other)).resolves.toMatchObject({ protocol: "openai-realtime" });
  });
});

describe("parseAllowedPlugins", () => {
  it("splits on commas and white space", () => {
    expect([...parseAllowedPlugins(" voice-mode,  other\nthird ,")]).toEqual(["voice-mode", "other", "third"]);
    expect([...parseAllowedPlugins(undefined)]).toEqual([]);
  });
});
