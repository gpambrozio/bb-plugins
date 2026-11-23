import { describe, expect, it } from "vitest";

import { callToken, chooseConnection } from "./credentials";

const SIGN_IN = { protocol: "openai-realtime", url: "wss://api.openai.com/v1/realtime", headers: { authorization: "Bearer chatgpt-token" }, model: "gpt-realtime-2.1" };

function deps(connection: string, openaiApiKey: string | undefined, codex: () => Promise<unknown> = async () => SIGN_IN) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      settings: async () => ({ connection, openaiApiKey }),
      callCodexRealtime: async () => {
        calls.push("codex-realtime");
        return codex();
      },
    },
  };
}

describe("the connection", () => {
  it("is the API key when set on auto, else the ChatGPT subscription", () => {
    expect(chooseConnection("auto", true)).toBe("api-key");
    expect(chooseConnection("auto", false)).toBe("chatgpt");
    expect(chooseConnection("chatgpt", true)).toBe("chatgpt");
    expect(chooseConnection("api-key", false)).toBe("api-key");
  });

  it("uses the API key without asking codex-realtime", async () => {
    const { calls, deps: d } = deps("auto", "  sk-test-key  ");
    expect(await callToken(d)).toEqual({ token: "sk-test-key", connection: "api-key" });
    expect(calls).toEqual([]);
  });

  it("takes the ChatGPT sign-in's bearer from codex-realtime", async () => {
    const { calls, deps: d } = deps("auto", "");
    expect(await callToken(d)).toEqual({ token: "chatgpt-token", connection: "chatgpt" });
    expect(calls).toEqual(["codex-realtime"]);
  });

  it("says what to do when the chosen connection cannot serve", async () => {
    await expect(callToken(deps("api-key", undefined).deps)).rejects.toThrow(/no OpenAI API key is set/u);
    const refused = deps("chatgpt", "sk-unused", async () => {
      throw new Error("voice-pilot may not use the sign-in");
    });
    await expect(callToken(refused.deps)).rejects.toThrow(/codex-realtime answered: voice-pilot may not use the sign-in/u);
    await expect(callToken(deps("chatgpt", undefined, async () => ({ ...SIGN_IN, headers: {} })).deps)).rejects.toThrow(/without a bearer/u);
  });
});
