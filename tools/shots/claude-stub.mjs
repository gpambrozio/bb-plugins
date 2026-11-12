#!/usr/bin/env node
// A stand-in `claude` on the dev bb's PATH. bb finds Claude Code installed (`--version`) and reads
// its model list from the CLI's `initialize` handshake, so the composer can show Claude Code and its
// skills. A one-shot `claude -p` (a plugin's helper call, such as Herald's sentence writer) gets a
// canned answer: the first entry of SHOTS_CLAUDE_PRINT (a JSON file of [{ "match": "regex", "reply":
// string or object }], see Seeder.claudePrint) whose `match` finds the prompt on stdin. Anything else,
// such as a user turn or a prompt no entry matches, ends the process with an error: no Claude Code
// session can run in the dev bb, whatever is on the real PATH or in the keychain.
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Newer than any release, so bb offers no update for it.
const VERSION = "99.0.0";
const MODELS = [
  { value: "opus", displayName: "Opus 5.5", description: "Opus 5.5" },
  { value: "sonnet", displayName: "Sonnet 5.5", description: "Sonnet 5.5" },
  { value: "haiku", displayName: "Haiku 5.5", description: "Haiku 5.5" },
];

const [first] = process.argv.slice(2);
if (first === "--version" || first === "-v") {
  console.log(`${VERSION} (Claude Code)`);
  process.exit(0);
}

const refuse = (what) => {
  process.stderr.write(`claude is a stub in the screenshot dev bb and never runs a model (got ${what})\n`);
  process.exit(1);
};
const args = process.argv.slice(2);
// A session (`--input-format stream-json`, with or without -p) goes to the handshake below instead.
if ((args.includes("-p") || args.includes("--print")) && !args.includes("--input-format")) {
  const prompt = readFileSync(0, "utf8");
  const file = process.env.SHOTS_CLAUDE_PRINT;
  const replies = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  const entry = replies.find(({ match }) => new RegExp(match, "i").test(prompt));
  if (!entry) refuse(`a -p prompt no canned reply matches: ${JSON.stringify(prompt.slice(0, 200))}`);
  const format = args[args.indexOf("--output-format") + 1];
  if (args.includes("--output-format") && format === "json") {
    const structured = typeof entry.reply === "string" ? undefined : entry.reply;
    const result = typeof entry.reply === "string" ? entry.reply : JSON.stringify(entry.reply);
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result, structured_output: structured }));
  } else {
    console.log(typeof entry.reply === "string" ? entry.reply : JSON.stringify(entry.reply));
  }
  process.exit(0);
}
if (!process.argv.includes("--input-format")) refuse(`arguments ${JSON.stringify(process.argv.slice(2))}`);

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type !== "control_request" || message.request?.subtype !== "initialize") refuse(message.type);
  const response = { commands: [], agents: [], models: MODELS, output_style: "default", available_output_styles: ["default"], account: {} };
  process.stdout.write(
    JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } }) + "\n",
  );
});
