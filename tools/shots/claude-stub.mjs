#!/usr/bin/env node
// A stand-in `claude` on the dev bb's PATH. bb finds Claude Code installed (`--version`) and reads
// its model list from the CLI's `initialize` handshake, so the composer can show Claude Code and its
// skills. Anything else, such as a user turn, ends the process with an error: no Claude Code
// session can run in the dev bb, whatever is on the real PATH or in the keychain.
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
