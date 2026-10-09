# AGENTS.md

This file provides guidance to coding agents working in this repository.

Plugins for [bb](https://getbb.app), one self-contained folder per plugin. They are ports of the
six Paseo plugins in [`gpambrozio/paseo-plugins`](https://github.com/gpambrozio/paseo-plugins) —
`skills`, `github-board`, `launchd-jobs`, `herald`, `model-pricing` and `firstmate` — each tracked
by its own issue in this repository. Plugin code is full-trust and unsandboxed: the server half runs
**inside the bb server's own process**, and the app half runs inside the bb app.

The plugins pin **`@get-bb/plugin-sdk` 0.6.15** and CI builds them with **bb 0.45.0**. This file was
written against bb 0.44.0 and SDK 0.5.29 and re-checked against the 0.45.0 changes; a point that names
bb 0.44 was observed there and still holds in 0.45 unless it says otherwise. When the two
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
parent/child thread supervision, and its own skill management (`bb skill`, `bb.sdk.skills`, Settings →
Skills). Duplicating a built-in is a decision to record in the issue, not a default.

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

CI and the release workflow read their plugin list from the same file, so listing a plugin there is
all it takes to check and release it; the consistency check fails a plugin folder that is not
listed. See *CI and releases*.

## Starting a plugin

```bash
cd ~/repositories/bb-plugins
bb plugin new <id>          # scaffolds ./bb-plugin-<id>; rename the folder to <id>
```

Then set the package name to `@gpambrozio/bb-plugin-<id>`. **The plugin id is the package name's
last segment minus `bb-plugin-`**, so the scope costs nothing, and the id is the Paseo one unless it is
taken. Check both places before you scaffold: `bb plugin list` shows the built-ins (an install over a
reserved id is refused), and `entries/<id>.json` in `get-bb/marketplace` shows the Community ids (see
*Submitting to the BB Community marketplace*). The FirstMate port is `firstmate-crew` for that reason.

The scaffold ships a todo-list example (`server.ts`, `app.tsx`, `skills/example-todos/`). Delete the
example before writing anything. If the plugin has no UI, remove `bb.app` from the manifest and the
frontend files with it.

## The manifest is `package.json`

There is no separate manifest file. The `bb` key carries it:

```json
"engines": { "bb": ">=0.45", "bbPluginSdk": ">=0.6.15" },
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
- `icon` is a name from bb's own icon set, not Lucide's (see **Icon names are bb's own set** under
  *App*). An unknown name falls back to a default icon rather than failing the load, so a typo is
  silent — check the name against `herald/app/testing/bb-icon-names.ts`.
- Declare only what the plugin implements.
- `engines` is the oldest bb the plugin runs on, not the SDK it is typed against. An older bb builds a
  plugin pinned to a newer SDK and only warns ("This plugin pins @get-bb/plugin-sdk 0.6.15; this bb's
  SDK is 0.5.29"), so a re-pin alone raises nothing. Raise `engines.bb` and `engines.bbPluginSdk` when
  the plugin starts calling an API the older bb lacks (`skills` needs `composer.replace`, so it asks for
  bb 0.45), and make that a minor version: installs on the older bb stop at the previous one.

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
                                 # only methods registered with `experimental_discoverable`, `call` reaches all;
                                 # without --input-file `call` sends null, so pass a file holding `{}`
bb plugin types                  # repin the SDK to the running bb; --check in CI
```

`bb plugin types` writes the *running* bb's SDK version, so on a machine whose bb is older than CI's it
moves the pin backwards. Re-pin with `npm install --save-exact -D @get-bb/plugin-sdk@<version>` there.

- **`~/.npm` on this machine has root-owned files**, so a plain `npm install` fails. Pass
  `--cache "$TMPDIR/npm-cache"` rather than fixing permissions from an agent; for `npx shadcn add`,
  set `npm_config_cache="$TMPDIR/npm-cache"` instead.
- **The scaffold has no test runner.** Add vitest per plugin (the Paseo tests are vitest and port
  directly) and a `"test": "vitest run"` script. The SDK ships harnesses:
  `@get-bb/plugin-sdk/testing` (`createFakePluginHost()` → `{ bb, harness }`, event and thread
  fixtures, `experimental_scanPublicSdkOnly` for the import boundary),
  `@get-bb/plugin-sdk/testing/app` (`loadPluginApp`, `renderSlot`; needs jsdom and Testing Library),
  and `@get-bb/plugin-sdk/testing/host`. `loadPluginApp` captures slots and composer customizations
  but not `app.commands` registrations; run the definition's `setup` against a stub builder to test
  those (`skills/app/app.test.tsx`).
- The first `bb plugin build` on a machine downloads a pinned esbuild and Tailwind into
  `<dataDir>/plugins/toolchain-*/`. The `bb` CLI from the npm package `bb-app` builds without a
  running bb; this repository's CI installs it globally at one pinned version
  (`.github/actions/setup-bb`) rather than as a devDependency of every plugin.
- **Inside a bb thread, every `bb` is the live one.** bb sets `BB_CLI` in a thread's environment, and
  any `bb` entrypoint — one installed from npm into a temp folder included — re-execs that binary. To
  build with another version (CI's `bb-app`, say), unset it: `env -u BB_CLI ./node_modules/.bin/bb
  plugin build`. Check with `bb --version`; the SDK warning a build prints names the version that ran.
- **A failed reload keeps the previous instance running** and `bb plugin reload` exits 1 — the
  opposite of Paseo. Read the exit code and the logs; "it still works" does not mean the new code
  loaded. The new instance loads *before* the old one is disposed (the SDK's fake host does the same),
  so a storage write the old one had queued may not have landed when the new one reads. `herald`
  re-reads storage when the old instance signals it has drained (`herald/server/reload-signal.ts`).
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
| React to threads | `bb.events.on("thread.idle" \| "thread.failed" \| "interaction.pending" \| …, handler)` — observe only. There is no event for an interaction being *answered*: read `threads.interactions.get`, or `hasPendingInteraction` from `experimental_useSidebarThreads` in the app |
| Gate a send | `bb.experimental_hooks.on("message.dispatch", …)` — fails closed, 10 s limit |
| Settings | `bb.settings.define({...})` → `get()`, `experimental_set()`, `onChange()`; the host renders the form; `secret: true` never reaches the app |
| Storage | `bb.storage.kv` (JSON, 256 KB per value) or `bb.storage.database()` (own SQLite) with append-only `bb.storage.migrate` |
| bb itself | `bb.sdk` — threads (`spawn`, `send`, `list`, `timeline`, `stop`, `archive`, `delete`, plugin metadata), projects, environments, hosts, files, terminals, providers, skills |
| A CLI | `bb.cli.register` / `defineCli` — one registration per plugin; output capped at 1 MiB |
| Agent tools and instructions | `bb.agents.registerTool`, `bb.agents.configure`, `bb.agents.contributeInstructions` — apply from the next provider session start, never mid-session |
| Cleanup | `bb.onDispose(fn)` (LIFO); dispose every service, listener and resource |

Use `bb.sdk` from handlers and services, not the factory body.

What a port only learns by running it:

- **The server cannot find its own folder.** `bb plugin build` compiles the entry into bb's cache, so
  nothing at run time names the plugin's directory, and a `templates/` or `data/` folder beside
  `server.ts` is unreachable. Ship such data through a generated module (a script writes the files
  into a checked-in `.ts` file, a test fails when the two differ), as `firstmate-crew` does.
- **A plugin WebSocket has no `bufferedAmount`.** `bb.http.experimental_websocket`'s socket offers
  `send`, `close` and `readyState` only, so the server cannot tell that a client is falling behind; a
  route that streams needs the client to acknowledge what it received (`screen-sharing/app/flow.ts`).
  The fake host closes route sockets with 1012 before running dispose hooks, as bb does.
- **`bb.storage.kv` is 256 KB per value.** A queue or a log that can outgrow that belongs in a file
  beside the data it describes, or in `bb.storage.database()`.
- **A plugin CLI command knows its caller.** `run(input, ctx)` gets the calling thread and project
  (`ctx.threadId`, `ctx.projectId`, from the caller's `BB_THREAD_ID` and `BB_PROJECT_ID`) and its
  `cwd`. The thread id is only what the caller's environment says, so treat it as a claim, not an
  identity. An option declared `stdin: true` is also accepted as `--<name>-stdin`: the caller's `bb`
  reads it from stdin on the caller's machine, but in bb 0.44 only as exactly one non-empty line of at
  most 16 KiB, and the multi-line `--stdin` that `bb guide plugins` describes is not in 0.44's CLI. For
  arbitrary text, send it base64-encoded through `--<name>-stdin` and decode it with a size cap
  (`firstmate-crew`'s `tell --message-base64`), rather than having the server read a file by path.
- **A thread spawn into a host workspace needs a `hostId`.** The SDK type marks it optional, bb 0.44
  answers `hostId is required unless workspace.type is personal`. Take the server's own machine from
  `bb.sdk.system.config().primaryHostId`, or the host of the project's checkout.
- **`bb.sdk.projects.list()` leaves out the personal project** unless called with
  `{ includePersonal: true }`. Every bb has one (`proj_personal`); it is where a thread that needs no
  checkout can run (`workspace: { type: "personal" }`).
- **A project knows its `origin`.** `bb.sdk.projects.list()` carries `gitRemoteUrl` (any spelling:
  scp, https, with or without `.git`; null when there is none), so matching a repository to a project
  needs no `git` call. The same repository is often a separate project per machine, so expect several.
- **A thread's machine and directory are its environment's.** `threads.get` gives `providerId` and
  `environmentId`; `environments.get` gives `hostId` and `path`. An archived thread's environment is
  `destroyed`, with a null `path`. A thread in a worktree runs somewhere other than the project's
  checkout, so anything keyed on the checkout's path (Claude Code's project-scoped plugins, for one)
  has to map the worktree back to its main checkout (`skills/host/resolve/repo-root.ts`).
- **`bb.status.needsConfiguration(message)` lasts until the next load.** Fixing the cause does not
  clear it; tell the user to `bb plugin reload <id>`.
- **The server's PATH may lack Homebrew.** The server takes the login shell's PATH, but keeps the one
  it was started with when that lookup fails; try `/opt/homebrew/bin` and `/usr/local/bin` by path
  for a tool such as `gh`, as bb's built-in GitHub plugin does.

**Settings are writable from the server** (`experimental_set`), unlike Paseo, where only the
client could write a settings document. That erases the Paseo split between "settings document"
and "the daemon's own file"; decide per value whether the user edits it in the host-rendered form
(settings) or the plugin owns it (storage).

**Hidden threads replace helper agents.** `bb.sdk.threads.spawn({ visibility: "hidden", … })`
keeps a background worker out of the sidebar and out of bb's unread attention. The plugin must `stop`
it in a `finally` and archive it when done. Hidden is not silent: bb delivers a hidden thread's events
to every plugin's `bb.events` handlers, the spawning plugin's included. Recognise your own by
`thread.originPluginId === bb.pluginId`, which bb stamps on every thread spawned with `pluginMetadata`.
Do not make a helper a child of the thread it works for: a child notifies its parent when it finishes,
which puts a message in that thread. **A helper thread cannot be made tool-free**: bb's least
privileged `permissionMode` is `accept-edits` (Claude Code reads and edits files in the workspace without
asking), `threads.spawn` takes no tool list, and the only plugin hook is `message.dispatch`. A helper fed
untrusted text is a decision to record, not a default. **Bounding helpers across a reload is the hard
part**: the new instance loads before the old one is disposed, so a spawn the old one sent can answer
after the new one has checked for leftovers, and a clean-up that fails or is aborted must keep spawning
shut. `herald` dropped its helpers over this and has a command-line tool (`claude -p --tools ""`, a child
process of the server, see `herald/AGENTS.md`) write its sentences instead; issue #11 lists what a plugin that spawns them must
guarantee.

### Host entry — `bb.host`

`server.ts` runs on the machine running the bb server. Anything that must touch *a specific
machine* — `launchctl`, `say`, a checkout on an enrolled host — belongs in a `bb.host` entry
(`experimental_defineHostEntry`), called from the server with
`bb.hosts.experimental_client({ contract }).call(method, input, { hostId })`. It is bundled as a
self-contained Node 22 ESM file and delivered to the host daemon. Import `experimental_defineHostEntry`
and `defineRpcContract` from the SDK **root**: the host builder stubs those, so the SDK stays an exact
devDependency. Importing an SDK subpath such as `/host` needs the SDK as a real `dependency`. When
everything runs on one Mac, skipping `bb.host` works, but it is the wrong machine the day a remote host
is enrolled — say which one you chose in the plugin's `AGENTS.md`. `launchd-jobs` is the worked example.

- `context.experimental_paths.dataDir` is `<daemon data dir>/plugins/<id>/host-data/` —
  `~/.bb/plugins/<id>/host-data/` on the server's Mac. It survives reloads; the host manager deletes
  only the worker's `tempDir`. It is the place for files a host process outside bb must find by path,
  such as a script launchd runs.
- A native watch (`context.experimental_watch`) and `context.experimental_emitSignal` keep working
  after the call that set them up has returned; the server receives the signal through
  `experimental_onSignal`. An active watch keeps the worker alive, so give it an expiry.
- The worker stops after five idle minutes. A server-side poll more frequent than that keeps it running
  for good; say so where you add one.
- **Host signals are lossy and only ordered in practice.** `experimental_emitSignal` resolves once the
  worker has handed the signal to the daemon, not on delivery. The daemon sends it over its one
  connection to the server, which starts each `experimental_onSignal` handler as it arrives, so
  signals arrive in order but are dropped while the link is down, and nothing guarantees either. A
  stream over signals needs sequence numbers and its own credit (`screen-sharing`'s host link).
- **Concurrent host calls are not delivered in order.** bb's server awaits per call
  (`resolveHostEnvironment`) before sending each one to the daemon, so a call made after another can
  reach the host first. Number calls whose order matters and reorder them on the host, or wait for
  each answer before the next call.
- **`context.experimental_retainWorker()` works only while the call that asks is running**; it throws
  afterwards. Take the lease in the handler that starts the background work, and release it on every
  way that work ends.
- **Testing a host entry:** `experimental_createHostEntryHarness` (`@get-bb/plugin-sdk/testing/host`)
  runs it with the daemon's validation and counts leases. Wiring `createFakePluginHost`'s
  `experimental_callHostRpc` and `harness.experimental_emitHostSignal` to the entry's logic tests the
  server and host together (`screen-sharing/testing/fake-daemon.ts`).

### App — `app.tsx`

```tsx
import { definePluginApp } from "@get-bb/plugin-sdk/app";

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "board", title: "GitHub", icon: "Github", path: "board", component: Board });
});
```

Plain web React with the DOM lib — `document` and `window` are fine, on every client: the desktop app is
Electron and the mobile app is a native shell around the same web app in a WebView. Where behaviour must
differ (audio needs a tap first in a browser tab and in the mobile app), bb's own plugins tell them apart
by `window.bbDesktop` (desktop) and a `window.bb.native` bridge (mobile) — internals, not SDK. Work that
must run while no page is open, such as `herald`'s announcer, belongs in `app.slots.experimental_appOverlay`,
mounted once per window. Paseo contribution → bb slot:

| Paseo | bb |
| --- | --- |
| `addSurface` + `addSidebarItem` | `app.slots.navPanel` (own sidebar entry and route `/plugins/<id>/<path>/*`); a live count beside the row is its `experimental_sidebarAccessory` component, not a re-registration |
| `addWorkspacePanel` (agent context) | `app.slots.threadPanelAction` (gets `threadId`) |
| `addSettingsScreen` | host-rendered form from `bb.settings.define`, plus `app.slots.settingsSection` for anything custom |
| `addCommandCenterItem` | `app.commands.register` — its `run` gets no navigation; hand it `useBbNavigate()` from an `app.slots.experimental_appOverlay` component that renders nothing (`github-board/app.tsx`) |
| slash commands, composer pills | `app.composer.customize` (`actions` draws a component in the thread composer's toolbar; a pop-up over the composer is `experimental_popups`, opened with `useComposer().experimental_openPopup` — drawn *inside the composer's `<form>`*, so give every button `type="button"` and stop `mousedown` at its root, see `skills/AGENTS.md`), `app.composer.experimental_registerCommand` for a bindable key, a `{ kind: "command" }` mention through `composer.replace` for the pill bb's `/` menu inserts, `app.slots.pendingInteraction` |
| `addTimelineRenderer` | `app.slots.experimental_timelineRenderer` (kind `<pluginId>/<name>`), or `messageDirective` — but only for rows a provider bridge or `bb.ui.requestInput` writes. **A plugin cannot append a row to a thread's timeline** (no `timeline.append`); put the context in the prompt and `pluginMetadata` instead |
| `useRpc(contract)` | `useRpc<typeof rpcContract>().call(method, input)`, the contract imported *as a type* from `./server` |
| `usePaseo()` | `useSdk()` — prefer it over a plugin RPC for anything that only reads or changes bb state |
| `navigation.openAgent`, `openExternalUrl` | `useBbNavigate()` — `toThread`, `toProject`, `toPluginPanel`, `openThreadPanel`, `openUrl` (follows the user's in-app/external browser preference; there is no "open a browser tab here") |
| `theme.colors` tokens | Tailwind semantic classes (`bg-background`, `text-muted-foreground`, `border-border`, `bg-card`, `text-destructive`, `border-warning`/`text-warning-text`, `text-success`, `bg-state-hover`) |
| host UI kit | shadcn components vendored into `components/ui/` (`npx shadcn add @bb/<name>`), plus host `Markdown`, `ThreadChat`, `ThreadTitle`, `UrlLink` |

`app.slots.settingsSection` requires an `id` (letters, digits, `-`, `_`), unlike the Paseo settings screen.

A hand-built new-thread dialog becomes `experimental_NewThreadComposer`: it resolves a request and the
plugin spawns it. Mount it only once its `default*` seeds are known — changing one re-seeds every
selection — and give it a `draftKey` per subject, since `initialPrompt` seeds only an empty draft.

**The composer is one handle, `useComposer()`** (SDK 0.6, bb 0.45). Inside a composer slot it is that
composer; in a thread's panels, that thread's draft. It carries `scope`, `draft` (text and mention
pills), `replace`, `insert` (at the cursor or the end), `focus` and `submit`. `useComposerView`,
`updateText`, `setText` and the other 0.5 names are gone from the types but still run, so a build typed
against 0.5.29 keeps working on bb 0.45. `replace` takes text and mentions together and does not move
mention ranges for you: shift them by what the edit added before them, as `skills/app/insert.ts`
does. bb 0.44 has no `replace`, `insert` or `draft`.

Host `Markdown` takes only `content` and `className`, so it gives no say over how a body's images
load. Where they need gating (tracking pixels, private attachments), render the body yourself, as
`github-board` does, or defuse them in the source by parsing it as bb does (mdast with GFM) and
editing each image and raw-HTML node by its position, as `skills/app/markdown.ts` does — patterns over
the raw text miss reference, nested and multiline images.

**Icon names are bb's own set, not Lucide's.** `experimental_Icon` (and every `icon` field) knows about
170 names — `Settings`, `Play`, `Spinner`, `Lock`, `ListTodo`, `MessageQuestion`, `Github`… but no
`Volume2`, `RefreshCw`, `Megaphone`, `Shield` or `Loader2` — and draws its generic bolt for anything else,
silently. A missing glyph is an SVG declared in `bb.branding.experimental_icons` and named
`"<pluginId>/<name>"`. `herald/app/testing/bb-icon-names.ts` holds bb 0.44's list and
`herald/app/icons.test.ts` the check. bb's vendored `Button` takes no `title`; a tooltip is bb's
`Tooltip` (`npx shadcn add @bb/tooltip`).

Colour comes from the semantic classes, never a literal — check light and dark. Where a literal is the
point (`model-pricing`'s provider palette), pick it by `experimental_useCodeTheme().mode`, which follows
bb's own light/dark choice: Tailwind's `dark:` variant compiles to `prefers-color-scheme`, the
operating system's. The app also has a compact viewport (`isCompactViewport` on some slots); check a
narrow window too. A throwing slot collapses to a "plugin crashed" chip instead of taking the app down,
so a blank area is a crash to look for in the console, not a layout bug.

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
- **The app must not import the SDK root at run time**, directly or through a shared module. bb
  provides `@get-bb/plugin-sdk` (e.g. `defineRpcContract`) to the server bundle and shims only
  `@get-bb/plugin-sdk/app` in the app bundle, so an app → `shared/contract.ts` value import builds
  from a dev install and fails the production-only build a git install runs. Keep what the app needs
  at run time (channel names, schemas) in a module that does not import the SDK, and import the
  contract as a type.

## CI and releases

Each plugin releases on its own, from per-plugin tags on `main`: `<id>/vX.Y.Z`, the way
`paseo-plugins` already does it. Never cut a bare `vX.Y.Z` tag, and never move a tag — bb refuses a
tag that now names a different commit. **Merging a version bump is the release**:

1. In the pull request, bump `version` in the plugin folder (`npm version <patch|minor|major>
   --no-git-tag-version` keeps the lockfile in step) and add a `## X.Y.Z` section to its
   `CHANGELOG.md`.
2. Merge it. `.github/workflows/release.yml` sees a version with no tag, builds the plugin as a git
   install does, typechecks and tests it, then pushes the annotated tag `<id>/vX.Y.Z` on the commit
   that introduced the version (the bump's merge) and creates the GitHub release `<id> X.Y.Z` with
   that changelog section as its notes.
3. Installs following a compatible range — the README's command and the marketplace entry — pick the
   tag up on their next update check. Only a change of range (or of anything else in the entry) needs
   a marketplace pull request.

Do not tag by hand. Every run releases whatever version has no tag or no GitHub release, so a failed
or cancelled release is finished by the next push, by "Re-run all jobs", or by `workflow_dispatch` with
the plugin id. A run never moves a tag: it verifies and releases the commit an existing tag names.

`.github/workflows/checks.yml` runs on every pull request, and branch protection requires only its
aggregate job, **Checks passed**:

- **Manifests agree** (`.github/scripts/check-plugin-consistency.mjs`): `.bb/plugins.json` follows
  bb's collection schema with unique names, and lists every plugin folder; the package name gives the folder's id; the version is `X.Y.Z` in
  `package.json`, both lockfile copies and a changelog section; the lockfile's dependency blocks match;
  the `bb` manifest's required fields and named files exist; the SDK is pinned exactly and satisfies
  `engines.bbPluginSdk`; `typecheck` and `test` scripts exist; `PLUGIN_OVERVIEW.md` fits the
  marketplace's 4000 characters with no `#` title.
- **Version bumps release** (`check-changelog-bump.mjs`): a changed `CHANGELOG.md` needs a version
  bump, and a bump must be to an untagged version no lower than the base's.
- **One job per plugin**: production-only `npm ci` and `bb plugin build`, as a git install does, then
  `npm ci`, `npm run typecheck` and `npm test`.

The scripts are plain Node with no dependencies; their shared helpers have tests
(`node --test ".github/scripts/*.test.mjs"`). Every plugin needs `typecheck` and `test` scripts.
The CI's bb version lives in `.github/actions/setup-bb/action.yml`; move it when the plugins' SDK pin
moves.

Installs track a semver range over those tags:

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@^X.Y.Z' --plugin <id> --tag-prefix <id>/
bb plugin install <id>@bb-community        # once the plugin is in the Community marketplace
```

- **A git install builds from source with production dependencies only**
  (`npm install --omit=dev --omit=optional --ignore-scripts`, then `bb plugin build`). A bundled import
  that is only a devDependency fails here and nowhere else. CI repeats that install and build for every
  pull request and release; to reproduce it locally, run `npm ci --omit=dev --omit=optional
  --ignore-scripts && bb plugin build` in a clean clone.
- **npm installs need a prebuilt `dist/`.** The scaffold's `.gitignore` excludes `dist/` and has no
  `files`, so `npm pack` ships no bundle and the install is refused. Add `files` and build before
  publishing; check with `npm pack --dry-run`. Git tags are the release channel here; npm is optional.
- Each plugin keeps its own `version` and `CHANGELOG.md`, as in `paseo-plugins`. The changelog is
  written for non-technical readers: what a user can observe, no RPC or file names.
- Give each plugin's `package.json` `repository` (with `directory`), `homepage`, `bugs` and `author`,
  as `firstmate-crew` does. The author is the GitHub account, not a personal name or an email.

## Submitting to the BB Community marketplace

The Community marketplace is [`get-bb/marketplace`](https://github.com/get-bb/marketplace): one JSON
entry per plugin, pointing at this repository's tags. Use bb's `submit-a-plugin` skill for the
workflow, and read the marketplace's `README.md`, `schema/marketplace-v2.schema.json` and
`marketplace.base.json` fresh every time — that contract changes independently of bb.

- **Choose the id before the first release, and check it is free.** The id is the package name's last
  segment minus `bb-plugin-`; the entry file must be `entries/<id>.json`. Look for that file in the
  marketplace and for a bb built-in (`bb plugin list`). `firstmate` was taken by another author's
  port, so ours is `firstmate-crew`. Renaming later touches the folder, the package name,
  `.bb/plugins.json`, the tag prefix, the plugin's `bb <id>` CLI (which charters and skills may name),
  anything that hardcodes `/settings/plugins/<id>`, and every user's settings, which are keyed by id.
- **The source must be public, and the tag must exist,** before the marketplace PR: its `npm run check`
  runs `git ls-remote` for a `<tagPrefix>vX.Y.Z` tag matching the range. The entry's source is
  `{ "git": { "url": "https://github.com/gpambrozio/bb-plugins.git", "subdir": "<id>", "tagPrefix":
  "<id>/", "range": "^X.Y.Z" } }`.
- **`PLUGIN_OVERVIEW.md` is copied to `overview/<id>.md`.** At most 4000 characters, no leading `#`
  title, `##` section headings, only `https` links; no raw HTML, images, tables, footnotes or task
  lists. Keep it saying the same thing as `bb.description` and the entry's description, at length.
- **Screenshots are expected:** one to six of the real plugin surface, PNG, JPEG or WebP, at least 1200
  pixels wide, at most 2 MiB, in `screenshots/<id>/`. Capture at 2× in a wide enough window; show real
  content with no home paths, tokens, email addresses or unrelated thread text. Lead with the surface a
  user meets first.
- **The description is a store listing.** The first sentence is the hook — the outcome, under about
  140 characters, starting with a verb, not with the plugin's name — and each later sentence one
  capability. Name every cost: an external service, an account, a separate install, a limited OS. No
  "powerful", "seamless", "easy" and the like.
- **The rest of the entry:** `category` is one id from `marketplace.base.json`; `icon` is a bb host icon
  name (ours use the manifest's) or a file vendored as `icons/<id>-<first 8 of sha256>.<ext>`, 256 KB
  at most; up to ten lowercase `tags`, not repeating the name or category; `author.github` is the
  account that opens the marketplace PR.
- **Validate in a clean marketplace clone** before the PR: `npm ci --ignore-scripts && npm run build &&
  npm run check`. Commit only `entries/<id>.json`, the icon, `screenshots/<id>/` and `overview/<id>.md`.
- A compatible release inside the entry's range needs no new marketplace PR. A change of source, name,
  branding, description, overview, category, screenshots or range does.

## Plugin docs

Each plugin gets its own `AGENTS.md` (the invariants a future agent must not break — port the
relevant ones from the Paseo plugin's `AGENTS.md` and delete the ones bb made moot) and `README.md`
(what it does, how to install). Commands, settings and operating constraints that *agents in bb
threads* need go in the plugin's own `skills/` directory, which bb imports into threads.

bb copies each skill folder into threads as it is, so keep a skill's tests out of it. Its frontmatter
keeps keys bb does not know, which makes a skill only the user can start possible: with
`disable-model-invocation: true`, Claude Code hides it from the model and still runs it when the user
types `/<name>` (bb hands Claude Code the typed text unchanged). `firstmate-crew/skills/fm` is the
example.

## Git

- Work each port on its own branch and open a pull request that closes its issue.
- Never `--no-verify`.
