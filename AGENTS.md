# AGENTS.md

This file provides guidance to coding agents working in this repository.

Plugins for [bb](https://getbb.app), one self-contained folder per plugin. They are ports of the
six Paseo plugins in [`gpambrozio/paseo-plugins`](https://github.com/gpambrozio/paseo-plugins) —
`skills`, `github-board`, `launchd-jobs`, `herald`, `model-pricing` and `firstmate` — each tracked
by its own issue in this repository. Plugin code is full-trust and unsandboxed: the server half runs
**inside the bb server's own process**, and the app half runs inside the bb app.

Everything below was checked against **bb 0.44.0** and **`@get-bb/plugin-sdk` 0.5.29**. When the two
disagree with this file, the installed SDK wins — its declarations are the contract, and `bb guide
plugins` is the prose. Fix this file when you find the drift.

## Porting, not transliterating

The Paseo source is the specification of *behaviour*, not of shape. Read the plugin's
`AGENTS.md` and `README.md` in `paseo-plugins` before starting — those files record the invariants
that were paid for, and most of them still hold. Then drop anything that only existed to work
around Paseo:

- Hermes eval quirks (`for…of` closures, async arrows) — the bb app is web React, not React Native.
- `server/host-imports.test.ts` and `server/sdk-types.ts` — Paseo packaging guards.
- `server/data-dir.ts` and every legacy-location migration — nothing here has an old location.
- Module-scope and `globalThis` caches that survived Paseo surface unmounts and reconnects — re-check
  whether bb's panel lifecycle needs them before copying them.
- Work-arounds for missing Paseo APIs (hard-deleting helper agents through the CLI, raw daemon
  session frames). bb may have the API; look before porting the hack.

Before porting a feature, check whether bb already ships it. bb has built-in plugins for
automations (scheduled agent and script runs), push notifications, ask-user-question and
parent/child thread supervision. Duplicating a built-in is a decision to record in the issue, not a
default.

Carry the pure logic across with its tests. Most of each Paseo plugin's `server/` and `shared/` is
plain Node and moves unchanged; the Paseo-coupled part is the entry wiring, the host API calls and
all of the UI.

## Repository layout

There is no workspace root. Each plugin folder is an independent npm package with its own
`package.json`, `node_modules`, lockfile and `tsconfig.json`. Nothing is hoisted, and there is no
root `package.json`. Every command below runs from inside a plugin folder.

Each folder is named after the plugin id. `.bb/plugins.json` at the repo root is the collection
manifest bb reads to install one plugin out of this repository; add an entry for each plugin as it
lands:

```json
{
  "$schema": "https://getbb.app/schemas/plugins.schema.json",
  "schemaVersion": 1,
  "name": "gpambrozio-bb-plugins",
  "plugins": [{ "name": "herald", "source": "./herald" }]
}
```

Sources must start with `./`; unknown fields, duplicates and the repo root are rejected. The file
is an index only — identity and entry points stay in each plugin's own `package.json`. Do not create
it with an empty `plugins` array before the first plugin exists.

## Starting a plugin

```bash
cd ~/repositories/bb-plugins
bb plugin new <id>          # scaffolds ./bb-plugin-<id>; rename the folder to <id>
```

Then set the package name to `@gpambrozio/bb-plugin-<id>`. **The plugin id is the package name's
last segment minus `bb-plugin-`**, so the scope costs nothing and the id stays the Paseo one. None of
the six ids collides with a bb built-in today; `bb plugin list` shows the built-ins, and an install
over a reserved id is refused.

The scaffold ships a todo-list example (`server.ts`, `app.tsx`, `skills/example-todos/`). Delete the
example before writing anything. If the plugin has no UI, remove `bb.app` from the manifest and the
frontend files with it.

## The manifest is `package.json`

There is no separate manifest file. The `bb` key carries it:

```json
"engines": { "bb": ">=0.44", "bbPluginSdk": ">=0.5.29" },
"bb": {
  "name": "Herald",
  "description": "Store-card text, about 140 characters",
  "branding": { "icon": "Megaphone" },
  "server": "./server.ts",
  "app": "./app.tsx"
}
```

- Required: `name`, `description`, `branding` (an `icon` or `logo.light`), `server`.
- Optional: `app` (frontend entry), `host` (a Node entry run by enrolled host daemons — see below),
  `skills` (default `skills/`; every directory with a `SKILL.md` becomes a skill imported into agent
  threads), `themes`.
- `icon` is a Lucide-style name. An unknown name falls back to a default icon rather than failing
  the load, so a typo is silent — look at it.
- Declare only what the plugin implements.

`PLUGIN_OVERVIEW.md` beside `package.json` is the long store listing (under 4000 characters, no
leading `#` title, no raw HTML, images or tables). The community marketplace requires it.

## Commands

```bash
npm install --include=dev
npx tsc --noEmit                 # typecheck
bb plugin build                  # dist/ bundles; talks to no server
bb plugin install path:$PWD --yes  # once, into the running bb; --yes when nothing can answer the prompt
bb plugin dev                    # watch, rebuild, reload (plugin must be installed)
bb plugin reload <id>            # by hand
bb plugin logs <id> -f
bb plugin list                   # status, services, schedules, handler timings
bb plugin rpc list <id>          # and `inspect`, `call <id> <method> --input-file`; list and inspect show
                                 # only methods registered with `experimental_discoverable`, `call` reaches all
bb plugin types                  # repin the SDK to the running bb; --check in CI
```

- **`~/.npm` on this machine has root-owned files**, so a plain `npm install` fails. Pass
  `--cache "$TMPDIR/npm-cache"` rather than fixing permissions from an agent.
- **The scaffold has no test runner.** Add vitest per plugin (the Paseo tests are vitest and port
  directly) and a `"test": "vitest run"` script. The SDK ships harnesses:
  `@get-bb/plugin-sdk/testing` (`createFakePluginHost()` → `{ bb, harness }`, event and thread
  fixtures, `experimental_scanPublicSdkOnly` for the import boundary),
  `@get-bb/plugin-sdk/testing/app` (`loadPluginApp`, `renderSlot`; needs jsdom and Testing Library),
  and `@get-bb/plugin-sdk/testing/host`.
- The first `bb plugin build` on a machine downloads a pinned esbuild and Tailwind into
  `<dataDir>/plugins/toolchain-*/`. To build without a running bb (CI), add `bb-app` as a
  devDependency and a `"build": "bb plugin build"` script.
- **A failed reload keeps the previous instance running** and `bb plugin reload` exits 1 — the
  opposite of Paseo. Read the exit code and the logs; "it still works" does not mean the new code
  loaded.
- **Settings changes do not reload the plugin.** Subscribe with `onChange`.
- `bb plugin remove` deletes the plugin's settings, secrets and schedules. To move a local plugin,
  install the new path instead.
- Never restart the bb server; it runs the user's threads.

## Architecture

### Server — `server.ts`

```ts
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";

export const rpcContract = defineRpcContract({ /* method: { input, output } zod */ });

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, handlers);
}
```

It runs in-process in the bb server — a busy loop or an unhandled rejection is the server's problem,
not a subprocess's. The surface a port uses most:

| Need | API |
| --- | --- |
| Client ⇄ server calls | `bb.rpc.register(contract, handlers)`; input *and* output are zod-validated, results must be plain JSON |
| Push to the app | `bb.realtime.publish(channel, payload)` — broadcast, not persisted; the app re-fetches on reconnect |
| Long-running work | `bb.background.service(name, { start(signal) })` — sleeps must wake on abort or reload reports "degraded" |
| Cron | `bb.background.schedule(name, "m h dom mon dow", fn)` — server-local time, only while loaded |
| React to threads | `bb.events.on("thread.idle" \| "thread.failed" \| "interaction.pending" \| …, handler)` — observe only |
| Gate a send | `bb.experimental_hooks.on("message.dispatch", …)` — fails closed, 10 s limit |
| Settings | `bb.settings.define({...})` → `get()`, `experimental_set()`, `onChange()`; the host renders the form; `secret: true` never reaches the app |
| Storage | `bb.storage.kv` (JSON, 256 KB per value) or `bb.storage.database()` (own SQLite) with append-only `bb.storage.migrate` |
| bb itself | `bb.sdk` — threads (`spawn`, `send`, `list`, `timeline`, `stop`, `archive`, `delete`, plugin metadata), projects, environments, hosts, files, terminals, providers, skills |
| A CLI | `bb.cli.register` / `defineCli` — one registration per plugin; output capped at 1 MiB |
| Agent tools and instructions | `bb.agents.registerTool`, `bb.agents.configure`, `bb.agents.contributeInstructions` — apply from the next provider session start, never mid-session |
| Cleanup | `bb.onDispose(fn)` (LIFO); dispose every service, listener and resource |

Use `bb.sdk` from handlers and services, not the factory body.

Three things a port only learns by running it:

- **The server cannot find its own folder.** `bb plugin build` compiles the entry into bb's cache, so
  nothing at run time names the plugin's directory, and a `templates/` or `data/` folder beside
  `server.ts` is unreachable. Ship such data through a generated module (a script writes the files
  into a checked-in `.ts` file, a test fails when the two differ), as `firstmate` does.
- **`bb.storage.kv` is 256 KB per value.** A queue or a log that can outgrow that belongs in a file
  beside the data it describes, or in `bb.storage.database()`.
- **A thread spawn into a host workspace needs a `hostId`.** The SDK type marks it optional, bb 0.44
  answers `hostId is required unless workspace.type is personal`. Take the server's own machine from
  `bb.sdk.system.config().primaryHostId`, or the host of the project's checkout.

**Settings are writable from the server** (`experimental_set`), unlike Paseo, where only the
client could write a settings document. That erases the Paseo split between "settings document"
and "the daemon's own file"; decide per value whether the user edits it in the host-rendered form
(settings) or the plugin owns it (storage).

**Hidden threads replace helper agents.** `bb.sdk.threads.spawn({ visibility: "hidden", … })`
keeps a background worker out of the sidebar. The plugin must `stop` it in a `finally` and archive
it when done.

### Host entry — `bb.host`

`server.ts` runs on the machine running the bb server. Anything that must touch *a specific
machine* — `launchctl`, `say`, a checkout on an enrolled host — belongs in a `bb.host` entry
(`experimental_defineHostEntry` from `@get-bb/plugin-sdk/host`), called from the server with
`bb.hosts.experimental_client({ contract }).call(method, input, { hostId })`. It is bundled as a
self-contained Node 22 ESM file and delivered to the host daemon. Importing an SDK subpath such as
`/host` needs the SDK as a real `dependency`. When everything runs on one Mac, skipping `bb.host`
works, but it is the wrong machine the day a remote host is enrolled — say which one you chose in the
plugin's `AGENTS.md`.

### App — `app.tsx`

```tsx
import { definePluginApp } from "@get-bb/plugin-sdk/app";

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "board", title: "GitHub", icon: "Github", path: "board", component: Board });
});
```

Plain web React with the DOM lib — `document` and `window` are fine. Paseo contribution → bb slot:

| Paseo | bb |
| --- | --- |
| `addSurface` + `addSidebarItem` | `app.slots.navPanel` (own sidebar entry and route `/plugins/<id>/<path>/*`) |
| `addWorkspacePanel` (agent context) | `app.slots.threadPanelAction` (gets `threadId`) |
| `addSettingsScreen` | host-rendered form from `bb.settings.define`, plus `app.slots.settingsSection` for anything custom |
| `addCommandCenterItem` | `app.commands.register` |
| slash commands, composer pills | `app.composer.customize`, `app.slots.pendingInteraction` |
| `addTimelineRenderer` | `app.slots.experimental_timelineRenderer` (kind `<pluginId>/<name>`), or `messageDirective` |
| `useRpc(contract)` | `useRpc<typeof rpcContract>().call(method, input)`, the contract imported *as a type* from `./server` |
| `usePaseo()` | `useSdk()` — prefer it over a plugin RPC for anything that only reads or changes bb state |
| `navigation.openAgent`, `openExternalUrl` | `useBbNavigate()` — `toThread`, `toProject`, `toPluginPanel`, `openThreadPanel`, `openUrl` |
| `theme.colors` tokens | Tailwind semantic classes (`bg-background`, `text-muted-foreground`, `border-border`, `bg-card`, `text-destructive`) |
| host UI kit | shadcn components vendored into `components/ui/` (`npx shadcn add @bb/<name>`), plus host `Markdown`, `ThreadChat`, `ThreadTitle`, `UrlLink` |

`app.slots.settingsSection` requires an `id` (letters, digits, `-`, `_`), unlike the Paseo settings screen.

Colour comes from the semantic classes, never a literal — check light and dark. The app also has a
compact viewport (`isCompactViewport` on some slots); check a narrow window too. A throwing slot
collapses to a "plugin crashed" chip instead of taking the app down, so a blank area is a crash to
look for in the console, not a layout bug.

## Dependencies — the opposite of the Paseo repo

- **Anything the bundle includes goes in `dependencies`** — zod, radix primitives, any library.
  Git installs run `npm install --omit=dev --ignore-scripts` and then build, so a bundled import
  that is only a devDependency fails the install.
- **Packages the host shims** — react, the radix portal families, `sonner`, `vaul`, `clsx`,
  `tailwind-merge`, `class-variance-authority`, `@pierre/diffs` — are type-only **devDependencies**
  at the host's version, never `dependencies`.
- **`@get-bb/plugin-sdk` is an exact devDependency** (`bb plugin types` keeps it at the running bb's
  version), unless server or host code imports an SDK *subpath* — then it is a real dependency.
- Import only public `@get-bb/plugin-sdk` entry points, never `@bb/*`.

## Distribution and releases

Nothing is published yet, and no CI exists. Until that changes, install from a path:

```bash
bb plugin install path:/Users/ci/repositories/bb-plugins --plugin <id>
```

The shape to grow into, from `bb guide plugins`:

- **Git install of one plugin:** `bb plugin install git:github.com/gpambrozio/bb-plugins@main
  --plugin <id>` (or `--subdirectory <id>`). This repository is private, so that needs git
  credentials on the installing machine.
- **Per-plugin tags** work the way `paseo-plugins` already does them — `<id>/vX.Y.Z` — and
  `--tag-prefix <id>/` resolves a semver range over them. Never cut a bare `vX.Y.Z` tag. A tag that
  moves to a different commit is refused by bb.
- **npm installs need a prebuilt `dist/`.** The scaffold's `.gitignore` excludes `dist/` and has no
  `files`, so `npm pack` ships no bundle and the install is refused. Add `files` and build before
  publishing; check with `npm pack --dry-run`.
- Each plugin keeps its own `version` and `CHANGELOG.md`, as in `paseo-plugins`. The changelog is
  written for non-technical readers: what a user can observe, no RPC or file names.

## Plugin docs

Each plugin gets its own `AGENTS.md` (the invariants a future agent must not break — port the
relevant ones from the Paseo plugin's `AGENTS.md` and delete the ones bb made moot) and `README.md`
(what it does, how to install). Commands, settings and operating constraints that *agents in bb
threads* need go in the plugin's own `skills/` directory, which bb imports into threads.

## Git

- Work each port on its own branch and open a pull request that closes its issue.
- Never `--no-verify`.
