#!/usr/bin/env node
// A scripted Agent Client Protocol agent: speaks ACP over stdio and replays canned turns instead of
// calling a model. Zero tokens, deterministic transcripts. The dev bb registers it as provider
// `acp-demo` through provider-acp's `customAgents` setting.
//
// SHOTS_SCRIPT names a JSON file: [{ "match": "regex", "reply": "markdown", "tools": [{ "title", "kind" }],
// "permission": { "title", "kind", "command" }, "waitFor": "token", "error": "message" }]. The first entry
// whose `match` finds the prompt's text answers it: its tool calls, then its reply, then, with
// `permission`, a permission request the turn waits on (bb approves it by itself unless the thread runs
// in its accept-edits mode; then nothing answers it and the thread stays waiting for the user). With
// `waitFor`, the turn then stays in flight until a file of that name exists in SHOTS_RELEASE_DIR (the
// seed's `release`) or bb cancels it; a token nobody releases keeps the thread working. With `error`,
// the turn finally fails with that message. SHOTS_ACP_LOG, when set, logs the protocol to that file.
//
// It never runs a command: bb starts it with no thread id and no dev-bb address, so a `bb` started from
// here would address the default server, which is the owner's.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const LOG = process.env.SHOTS_ACP_LOG;
const log = (line) => {
  if (LOG) appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
};
const script = process.env.SHOTS_SCRIPT ? JSON.parse(readFileSync(process.env.SHOTS_SCRIPT, "utf8")) : [];
const fallback = { reply: "Done." };
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Turns in flight that a session/cancel ends, by session id. */
const cancels = new Map();
let toolCalls = 0;
let requests = 0;
/** Requests this agent sent the client, by id: resolved with the client's response. */
const waiting = new Map();
const request = (method, params) =>
  new Promise((resolve) => {
    const id = `agent-${++requests}`;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

/** Resolves false once SHOTS_RELEASE_DIR/<token> exists, or true when bb cancels the turn first. */
function released(sessionId, token) {
  if (!/^[\w.-]+$/.test(token)) throw new Error(`waitFor token "${token}" must be a plain file name`);
  const file = process.env.SHOTS_RELEASE_DIR ? join(process.env.SHOTS_RELEASE_DIR, token) : null;
  return new Promise((resolve) => {
    const done = (cancelled) => {
      clearInterval(timer);
      cancels.delete(sessionId);
      resolve(cancelled);
    };
    const timer = setInterval(() => {
      if (file && existsSync(file)) done(false);
    }, 100);
    cancels.set(sessionId, () => done(true));
  });
}

async function prompt(id, { sessionId, prompt: parts }) {
  const text = (parts ?? []).map((part) => part.text ?? "").join("\n");
  const step = script.find((entry) => new RegExp(entry.match, "i").test(text)) ?? fallback;
  const update = (body) => send({ method: "session/update", params: { sessionId, update: body } });
  for (const tool of step.tools ?? []) {
    const toolCallId = `t${++toolCalls}`;
    update({ sessionUpdate: "tool_call", toolCallId, title: tool.title, kind: tool.kind ?? "read", status: "in_progress" });
    await sleep(150);
    update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
  }
  // Stream the reply in small pieces, as a model would.
  for (const chunk of step.reply.match(/[\s\S]{1,40}/g) ?? []) {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } });
    await sleep(20);
  }
  if (step.permission) {
    const toolCallId = `t${++toolCalls}`;
    const { title, kind = "execute", command } = step.permission;
    const toolCall = { toolCallId, title, kind, status: "pending", ...(command ? { rawInput: { command } } : {}) };
    update({ sessionUpdate: "tool_call", ...toolCall });
    const answer = await request("session/request_permission", {
      sessionId,
      toolCall,
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    update({ sessionUpdate: "tool_call_update", toolCallId, status: answer?.outcome?.optionId === "allow" ? "completed" : "failed" });
  }
  if (step.waitFor) {
    const cancelled = await released(sessionId, step.waitFor);
    if (cancelled) return send({ id, result: { stopReason: "cancelled" } });
  }
  if (step.error) return send({ id, error: { code: -32603, message: step.error } });
  send({ id, result: { stopReason: "end_turn" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  log(`<- ${message.method ?? "response"} ${line.slice(0, 300)}`);
  if (message.id !== undefined && !message.method) {
    waiting.get(message.id)?.(message.result);
    waiting.delete(message.id);
    return;
  }
  // Notifications need no answer; session/cancel ends a turn held by `waitFor`.
  if (message.id === undefined) {
    if (message.method === "session/cancel") cancels.get(message.params?.sessionId)?.();
    return;
  }
  switch (message.method) {
    case "initialize":
      return send({
        id: message.id,
        result: { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: {} }, authMethods: [] },
      });
    case "session/new":
      return send({
        id: message.id,
        result: {
          sessionId: `demo-${Date.now()}`,
          models: { currentModelId: "demo", availableModels: [{ modelId: "demo", name: "Demo" }] },
        },
      });
    case "session/prompt":
      return void prompt(message.id, message.params);
    default:
      // session/set_mode, session/set_model, authenticate and the like.
      return send({ id: message.id, result: {} });
  }
});
