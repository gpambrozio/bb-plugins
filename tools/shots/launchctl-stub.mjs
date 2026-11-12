#!/usr/bin/env node
// A stand-in `launchctl` on the dev bb's PATH. It keeps a launchd of its own in a JSON file and never
// runs the real one, so nothing a shot list does can load, start or stop a job in this Mac's launchd.
//
// SHOTS_LAUNCHD names the state file: { "services": { "<label>": { "running", "pid", "runs",
// "lastExitCode" } }, "disabled": ["<label>"] } (see Seeder.launchd). Every call is appended to
// SHOTS_LAUNCHCTL_LOG. It answers the modern verbs against `gui/<uid>` the way launchd does (the
// shapes `launchd-jobs/host/fake-launchd.ts` tests against); anything else fails with exit 1.
// `kickstart` counts a run but runs nothing.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const STATE = process.env.SHOTS_LAUNCHD;
const LOG = process.env.SHOTS_LAUNCHCTL_LOG;
const args = process.argv.slice(2);
if (LOG) appendFileSync(LOG, `${JSON.stringify(args)}\n`);

const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};
if (!STATE) fail("launchctl is a stub in the screenshot dev bb (no state file)");

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
state.services ??= {};
state.disabled ??= [];
const save = () => {
  writeFileSync(`${STATE}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${STATE}.tmp`, STATE);
};

const [verb, target = "", extra = ""] = args;
const domain = `gui/${process.getuid()}`;
const labelOf = (t) => (t.startsWith(`${domain}/`) ? t.slice(domain.length + 1) : fail(`launchctl stub: unknown target ${t}`, 64));
const notFound = (label) => fail(`Could not find service "${label}" in domain for user gui: ${process.getuid()}`, 113);

switch (verb) {
  case "print": {
    const label = labelOf(target);
    const service = state.services[label] ?? notFound(label);
    const lines = [`${target} = {`, `\tactive count = ${service.running ? 1 : 0}`, `\tpath = ${service.path ?? ""}`];
    lines.push(`\tstate = ${service.running ? "running" : "not running"}`);
    if (service.running && service.pid) lines.push(`\tpid = ${service.pid}`);
    lines.push(`\truns = ${service.runs ?? 0}`);
    if (service.lastExitCode !== undefined && service.lastExitCode !== null) lines.push(`\tlast exit code = ${service.lastExitCode}`);
    lines.push("\tendpoints = {", "\t\tstate = active", "\t}", "}");
    console.log(lines.join("\n"));
    break;
  }
  case "print-disabled":
    if (target !== domain) fail(`launchctl stub: unknown domain ${target}`, 64);
    console.log(`disabled services = {\n${state.disabled.map((label) => `\t"${label}" => disabled\n`).join("")}}`);
    break;
  case "bootstrap": {
    if (target !== domain) fail(`launchctl stub: unknown domain ${target}`, 64);
    const label = basename(extra, ".plist");
    if (state.disabled.includes(label)) fail("Bootstrap failed: 119: Service is disabled", 119);
    if (state.services[label]) fail("Bootstrap failed: 5: Input/output error", 5);
    state.services[label] = { running: false, runs: 0, lastExitCode: null, path: extra };
    save();
    break;
  }
  case "bootout": {
    const label = labelOf(target);
    if (!state.services[label]) fail("Boot-out failed: 3: No such process", 3);
    delete state.services[label];
    save();
    break;
  }
  case "enable":
  case "disable": {
    const label = labelOf(target);
    state.disabled = state.disabled.filter((l) => l !== label);
    if (verb === "disable") state.disabled.push(label);
    save();
    break;
  }
  case "kickstart": {
    const label = labelOf(args.at(-1));
    const service = state.services[label] ?? notFound(label);
    service.runs = (service.runs ?? 0) + 1;
    save();
    break;
  }
  default:
    fail(`launchctl is a stub in the screenshot dev bb and does not know ${JSON.stringify(args)}`);
}
