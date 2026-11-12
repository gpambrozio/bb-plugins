// Seeding a dev bb: fixture files in the fake HOME, a demo git project, a neutral machine name, the
// scripted provider as the default, and the plugin under test installed from its folder.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCRIPTED_AGENT = join(HERE, "..", "scripted-acp-agent.mjs");
/** provider-acp names a custom agent `acp-<id>`. */
export const DEMO_PROVIDER = "acp-demo";
/**
 * Providers the dev bb keeps: the scripted agent, and Claude Code, whose `claude` is a stub (see
 * claude-stub.mjs) so that composer shots can show it. Every other provider is disabled.
 */
export const KEPT_PROVIDERS = [DEMO_PROVIDER, "claude-code"];

/** Writes `files` ({ relative path: text }) under `dir`. */
export function writeTree(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}

/** A `SKILL.md` with frontmatter, for fixture skills. */
export function skillFile(name, description, body = description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
}

export class Seeder {
  constructor(devbb, { log = console.log } = {}) {
    this.bb = devbb;
    this.log = log;
    this.rpcCalls = 0;
  }

  get home() {
    return this.bb.cfg.home;
  }

  /** Writes fixture files into the dev bb's fake HOME. */
  homeFiles(files) {
    writeTree(this.home, files);
  }

  /** Renames the dev bb's machine, which otherwise carries this Mac's real name. */
  renameMachine(name = "Studio Mac") {
    const [machine] = this.bb.cliJson(["machine", "list", "--json"]);
    this.bb.cli(["machine", "rename", machine.id, name]);
    return machine.id;
  }

  /**
   * Registers the scripted ACP agent as provider `acp-demo`, makes it the default and first
   * provider, and disables every provider but KEPT_PROVIDERS. `turns` is the
   * agent's script (see scripted-acp-agent.mjs).
   */
  async scriptedProvider(turns = []) {
    const root = this.bb.cfg.root;
    const scriptPath = join(root, "demo-script.json");
    writeFileSync(scriptPath, JSON.stringify(turns, null, 2));
    const agents = [
      {
        id: "demo",
        displayName: "Demo agent",
        command: join(this.bb.cfg.bin, "node"),
        args: [SCRIPTED_AGENT],
        env: { SHOTS_SCRIPT: scriptPath, SHOTS_ACP_LOG: join(root, "acp-demo.log") },
      },
    ];
    this.bb.cli(["plugin", "config", "provider-acp", "set", "customAgents", JSON.stringify(agents)]);
    await this.bb.waitFor(`provider ${DEMO_PROVIDER}`, () =>
      this.bb.cliJson(["provider", "list", "--json"]).some((p) => p.id === DEMO_PROVIDER && p.available),
    );
    for (const provider of this.bb.cliJson(["provider", "list", "--json"])) {
      if (!KEPT_PROVIDERS.includes(provider.id)) this.bb.cli(["provider", "disable", provider.id]);
    }
    this.bb.cli(["settings", "general", "defaultProviderId", DEMO_PROVIDER]);
    this.bb.cli(["settings", "general", "providerOrder", JSON.stringify([DEMO_PROVIDER])]);
    this.bb.cli(["settings", "general", "telemetryEnabled", "false"]);
  }

  /**
   * Creates a git repository under the run's root with `files`, one commit, and a bb project for it.
   * Returns { id, path }.
   */
  project(name, files, { folder = name.toLowerCase().replace(/[^a-z0-9]+/g, "-") } = {}) {
    const path = join(this.bb.cfg.root, "demo", folder);
    writeTree(path, files);
    const git = (...args) =>
      execFileSync("git", ["-C", path, "-c", "user.name=Demo", "-c", "user.email=demo@example.com", ...args], {
        stdio: "ignore",
        env: { PATH: process.env.PATH, HOME: this.home },
      });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "Initial commit");
    const project = this.bb.cliJson(["project", "create", "--root", path, "--name", name, "--json"]);
    return { id: project.id, path };
  }

  /** Installs a plugin from its folder into the dev bb. */
  installPlugin(dir) {
    this.bb.cli(["plugin", "install", `path:${dir}`, "--yes"]);
  }

  /**
   * Spawns a thread on the scripted provider and waits until its log has an `until` event (see
   * THREAD_EVENTS): the turn's end by default, which a turn scripted to fail also reaches. A turn
   * whose script asks for a permission waits on it only under `permissionMode: "accept-edits"` (bb
   * approves it itself otherwise); wait for `THREAD_EVENTS.interaction` then. Only `acp-demo` is
   * allowed: a thread on any other provider would send a prompt to a real agent.
   */
  async thread({ projectId, title, prompt, provider = DEMO_PROVIDER, until = THREAD_EVENTS.turnEnded, permissionMode }) {
    if (provider !== DEMO_PROVIDER) throw new Error(`refusing to spawn a thread on ${provider}: only ${DEMO_PROVIDER} is scripted`);
    const mode = permissionMode ? ["--permission-mode", permissionMode] : [];
    const thread = this.bb.cliJson(["thread", "spawn", "--project", projectId, "--provider", provider, "--title", title, "--prompt", prompt, ...mode, "--json"]);
    await this.waitForEvent(thread.id, until, 1);
    return thread;
  }

  /** Sends another prompt to a seeded thread, on the scripted provider only, and waits as `thread` does. */
  async send({ threadId, prompt, until = THREAD_EVENTS.turnEnded }) {
    const { thread } = this.bb.cliJson(["thread", "show", threadId, "--json"]);
    if (thread.providerId !== DEMO_PROVIDER) throw new Error(`refusing to send to ${threadId} on ${thread.providerId}: only ${DEMO_PROVIDER} is scripted`);
    const before = this.events(threadId, until).length;
    this.bb.cli(["thread", "tell", threadId, prompt]);
    await this.waitForEvent(threadId, until, before + 1);
  }

  /** The thread's log events of `type`, oldest first. */
  events(threadId, type) {
    return this.bb.cliJson(["thread", "log", threadId, "--json", "--all"]).filter((event) => event.type === type);
  }

  async waitForEvent(threadId, type, count, { timeoutMs = 60_000 } = {}) {
    await this.bb.waitFor(`${type} #${count} on ${threadId}`, () => this.events(threadId, type).length >= count, { timeoutMs });
  }

  /** Calls a plugin's RPC method in the dev bb (`bb plugin rpc call`) and returns its answer. */
  rpc(pluginId, method, input = {}) {
    const file = join(this.bb.cfg.root, `rpc-input-${process.pid}-${++this.rpcCalls}.json`);
    writeFileSync(file, JSON.stringify(input));
    try {
      return this.bb.cliJson(["plugin", "rpc", "call", pluginId, method, "--input-file", file]);
    } finally {
      rmSync(file, { force: true });
    }
  }

  /** Canned answers for a one-shot `claude -p` (see claude-stub.mjs): [{ match, reply }]. */
  claudePrint(replies) {
    writeFileSync(join(this.bb.cfg.root, "claude-print.json"), JSON.stringify(replies, null, 2));
  }

  /**
   * The stub launchd's state (see launchctl-stub.mjs): `services` by label, each `{ running, pid,
   * runs, lastExitCode }`, and the `disabled` labels. A label not in `services` is not loaded.
   */
  launchd({ services = {}, disabled = [] } = {}) {
    writeFileSync(join(this.bb.cfg.root, "launchd.json"), JSON.stringify({ services, disabled }, null, 2));
  }

  /** Every call the stub `launchctl` answered, as argument lists. */
  launchctlCalls() {
    const log = join(this.bb.cfg.root, "launchctl.log");
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
}

/** Thread log event types a seed waits for. */
export const THREAD_EVENTS = {
  /** A turn ended, finished or failed (`data.status`). */
  turnEnded: "turn/completed",
  /** A permission or question the turn waits on was asked. */
  interaction: "system/interaction/lifecycle",
};
