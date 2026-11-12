#!/usr/bin/env node
// A scripted Agent Client Protocol agent: speaks ACP over stdio and replays canned turns instead of
// calling a model. Zero tokens, deterministic transcripts. The dev bb registers it as provider
// `acp-demo` through provider-acp's `customAgents` setting.
//
// SHOTS_SCRIPT names a JSON file: [{ "match": "regex", "reply": "markdown", "tools": [{ "title", "kind" }],
// "permission": { "title", "kind", "command" }, "error": "message" }]. The first entry whose `match`
// finds the prompt's text answers it: its tool calls, then its reply, then, with `permission`, a
// permission request the turn waits on (bb approves it by itself unless the thread runs in its
// accept-edits mode; then nothing answers it and the thread stays waiting for the user), or, with `error`, the turn fails with that message. SHOTS_ACP_LOG, when set, logs
// the protocol to that file.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const LOG = process.env.SHOTS_ACP_LOG;
const log = (line) => {
  if (LOG) appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
};
const script = process.env.SHOTS_SCRIPT ? JSON.parse(readFileSync(process.env.SHOTS_SCRIPT, "utf8")) : [];
const fallback = { reply: "Done." };
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  // Notifications (session/cancel) need no answer.
  if (message.id === undefined) return;
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
