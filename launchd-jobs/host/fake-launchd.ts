/**
 * Test support: a launchd that lives in memory, behind the same `RunCommand`
 * the host entry uses. `launchctl` calls change its state and are recorded in
 * order; `plutil` runs for real (macOS only), so the plists the module writes
 * are parsed the way they will be on a Mac; the zsh PATH probe answers a fixed
 * PATH. Nothing here touches the real launchd or `~/Library/LaunchAgents`.
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

import type { CommandFailure, RunCommand } from "./jobs";

const exec = promisify(execFile);

export const FAKE_UID = 501;
export const FAKE_LOGIN_PATH = "/opt/fake/bin:/usr/bin:/bin";

interface Service {
  running: boolean;
  runs: number;
  lastExitCode: number | null;
}

function failure(message: string, code: number): CommandFailure {
  const error = new Error(message) as CommandFailure;
  error.code = code;
  error.stderr = message;
  error.stdout = "";
  return error;
}

export function createFakeLaunchd() {
  const loaded = new Map<string, Service>();
  const disabled = new Set<string>();
  const calls: string[][] = [];
  /** Labels whose next bootstrap fails, as a broken plist would. */
  const refuseBootstrap = new Set<string>();
  const domain = `gui/${FAKE_UID}`;

  function labelOf(target: string): string {
    return target.slice(`${domain}/`.length);
  }

  const run: RunCommand = async (file, args) => {
    if (file === "plutil") {
      const { stdout } = await exec("plutil", [...args], { encoding: "utf8" });
      return { stdout };
    }
    if (file === "/bin/zsh") return { stdout: `some startup banner\n${FAKE_LOGIN_PATH}\n` };
    if (file !== "launchctl") throw new Error(`unexpected command ${file}`);
    calls.push([...args]);
    const [verb, target = "", extra = ""] = args;
    switch (verb) {
      case "print": {
        const service = loaded.get(labelOf(target));
        if (service === undefined) throw failure(`Could not find service "${labelOf(target)}" in domain for user gui: ${FAKE_UID}`, 113);
        return {
          stdout: [
            `${target} = {`,
            `\tstate = ${service.running ? "running" : "not running"}`,
            `\truns = ${service.runs}`,
            ...(service.lastExitCode === null ? [] : [`\tlast exit code = ${service.lastExitCode}`]),
            "\tendpoints = {",
            "\t\tstate = active",
            "\t}",
            "}",
          ].join("\n"),
        };
      }
      case "print-disabled":
        return {
          stdout: `disabled services = {\n${[...disabled].map((label) => `\t"${label}" => disabled\n`).join("")}}\n`,
        };
      case "bootstrap": {
        const label = basename(extra, ".plist");
        if (refuseBootstrap.has(label)) throw failure("Bootstrap failed: 5: Input/output error", 5);
        if (disabled.has(label)) throw failure("Bootstrap failed: 119: Service is disabled", 119);
        if (loaded.has(label)) throw failure("Bootstrap failed: 5: Input/output error", 5);
        loaded.set(label, { running: false, runs: 0, lastExitCode: null });
        return { stdout: "" };
      }
      case "bootout":
        if (!loaded.delete(labelOf(target))) throw failure("Boot-out failed: 3: No such process", 3);
        return { stdout: "" };
      case "enable":
        disabled.delete(labelOf(target));
        return { stdout: "" };
      case "disable":
        disabled.add(labelOf(target));
        return { stdout: "" };
      case "kickstart": {
        const service = loaded.get(labelOf(target));
        if (service === undefined) throw failure("Could not find service", 113);
        service.runs += 1;
        return { stdout: "" };
      }
      default:
        throw new Error(`unexpected launchctl ${args.join(" ")}`);
    }
  };

  return { run, loaded, disabled, calls, refuseBootstrap };
}
