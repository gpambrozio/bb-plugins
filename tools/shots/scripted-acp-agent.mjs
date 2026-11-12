#!/usr/bin/env node
// A scripted Agent Client Protocol agent: speaks ACP over stdio and replays canned turns instead of
// calling a model. Zero tokens, deterministic transcripts. The dev bb registers it as provider
// `acp-demo` through provider-acp's `customAgents` setting.
//
// SHOTS_SCRIPT names a JSON file: [{ "match": "regex", "reply": "markdown", "tools": [{ "title", "kind" }] }].
// The first entry whose `match` finds the prompt's text answers it. SHOTS_ACP_LOG, when set, logs
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
  send({ id, result: { stopReason: "end_turn" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  log(`<- ${message.method ?? "response"} ${line.slice(0, 300)}`);
  // Notifications (session/cancel) and responses need no answer.
  if (message.id === undefined || !message.method) return;
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
