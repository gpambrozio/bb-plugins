# AGENTS.md

A bb plugin that lists every skill a thread's agent can use, says where each one comes from, renders
its `SKILL.md`, and adds its command to the thread's message box. It is the port of the Paseo plugin
`skills` (0.4.0, Hermes included) — except that it never invokes a skill itself (see *Add to chat, not
invoke*).

The repository root `AGENTS.md` covers what every plugin here shares. This file covers only what is
specific to `skills`.

## Orientation

| File | What it owns |
| --- | --- |
| `host.ts` | The host entry: binds `shared/host-contract.ts` to `host/discover.ts`. |
| `host/discover.ts` | Provider id → resolver, the homes (`~/.claude`, `$CODEX_HOME`, `~/.agents`, `/etc/codex/skills`, `$HERMES_HOME`), and `read`, which re-runs discovery and reads only an id it produced. |
| `host/resolve/*` | Carried over from Paseo: Claude, Codex and Hermes search paths, the repo walk, one skills directory, ids. |
| `server.ts` | Binds the ports in `server/skills.ts` to `bb.sdk` and the host entry. |
| `server/skills.ts` | The two RPCs: thread → workspace, discovery + the skills taken from bb's list + the reported list, and `read`'s id boundary. |
| `server/reported.ts` | Splits bb's command list into skills and commands, minus every name already listed. |
| `shared/skills.ts` | Zod shapes, `SOURCE_KINDS`, first-wins dedupe. No SDK import: the app uses it at run time. |
| `shared/frontmatter.ts` | `SKILL.md` frontmatter. Used by the host and by the server (for bb's skills). |
| `shared/contract.ts`, `shared/host-contract.ts` | App ⇄ server and server ⇄ host contracts. The app imports them as types only. |
| `app/browser.tsx` | List, search, both detail screens, Add to chat — drawn by the panel and the popover. |
| `app/panel.tsx`, `app/composer-button.tsx` | The thread-panel tab, and the composer button with its count and popover. |
| `app/use-skills.ts`, `app/insert.ts` | The two RPC reads, and Add to chat: the text, where it goes in the draft, and which composers it may write to. |
| `app/markdown.ts` | Turns a body's images into links before bb's `Markdown` draws it. |

## What bb already does, and what this adds

bb 0.44 ships its own skill management: `bb skill list|show` and `bb.sdk.skills` list the skills in a
project's workspace with a scope, a provider and a path, and Settings → Skills manages them; bb's
composer `/` menu lists what `bb.sdk.projects.commands({ provider })` reports. This plugin is built on
both and adds:

- **One thread's view.** bb's list is per workspace and holds every installed provider's roots at
  once. The browser shows what *this thread's* provider loads, in that provider's precedence, one row
  per name.
- **What bb does not find.** Claude Code plugin skills (`installed_plugins.json`), which bb's list has
  none of; `.claude/skills` and `.agents/skills` in every directory from the thread's directory up to
  the repository root; and Hermes's pruned directories (`.archive`, `_org`, …) left out, which bb's list
  shows as live.
- **Source attribution and the body for everything that has a file**, including bb's own skills and
  Codex's plugin skills, which bb finds and the Paseo resolvers never read.
- **Add to chat**, from beside the conversation or from the composer.

## Decisions

**Which machine: a `bb.host` entry.** Discovery reads the thread's checkout or worktree and the
provider homes of the user the agent runs as, on whichever enrolled host holds the thread's
environment. The server resolves `threads.get` → `environments.get` to `{ providerId, hostId, path }`
and calls the host entry there (`bb.hosts.experimental_client(...).call(method, input, { hostId })`).
`bb.sdk.projects.files` reads only inside the workspace, so it cannot reach `~/.claude` and friends.
The host entry spawns nothing and keeps no state; the worker stops on its own after five idle minutes.

**Which directory: the environment's `path`.** A bb thread runs at its environment's root. An archived
thread's environment is `destroyed` with no path, and the browser says so rather than showing an empty
list.

**A linked worktree is its main checkout, for Claude plugins.** Claude keys a project-scoped plugin
install (`projectPath` in `installed_plugins.json`) by the repository's main checkout and applies it in
every worktree of it; measured live, a bb worktree thread loads a plugin whose only entry names the main
checkout. bb runs most threads in worktrees somewhere else on disk, so `projectPlacesOf` in
`host/resolve/claude.ts` maps the worktree to the same spot in the main checkout by reading `.git` →
`commondir` (no `git` call). Without it every project-scoped plugin skill vanishes in a worktree.

**bb's own skills, and the provider's plugin skills bb finds, come from `bb.sdk.skills.list`.** bb
injects its plugins' skills, `~/.bb/skills` and the workspace's `.bb/skills` into every thread, so
they are listed (kind `bb`) after the provider's own. bb's list also finds Codex plugin skills
(`~/.codex/plugins`); rows with scope `plugin` and the thread's own provider are listed as kind
`plugin`. Every other row of bb's list is another provider's root and is ignored — discovery reads the
thread's provider in its own order. Their ids are `bb:<bb skill id>`, and their body comes from
`bb.sdk.skills.getContent`.

**The reported list is bb's `/` menu.** Paseo asked the live session (`agent.commands()`); bb's
equivalent is `bb.sdk.projects.commands({ projectId, environmentId, provider })`, the list behind the
composer's `/` menu. Its `source` (`skill` | `command`) splits the two built-in sections, so the browser
agrees with the composer. A failure there is shown under its own heading and never loses the rest.

**Composer surfaces: an action, not a pill.** bb has no composer pill. `app.composer.customize`
`actions` renders a component in the thread composer's toolbar, so the button is a component that runs
the list itself and shows the count; it is `Skills` without a number until the first answer. It opens
bb's vendored `@bb/popover`, which is a bottom sheet on a narrow window. **Open in panel** calls
`useBbNavigate().openThreadPanel({ actionId: "skills" })`; the command palette entry opens the same tab.
Nothing patches the DOM.

**Add to chat, not invoke — the owner's decision.** The Paseo plugin (and issue #1's mapping) sent
`/name args` to the agent. This port has no Invoke, no arguments field and no send: its one action,
**Add to chat**, puts `/name ` at the start of the thread's message box and focuses it, so the user
adds arguments and sends the message themselves. Do not bring the send back without the owner asking.

**Add to chat writes the draft through `useComposer()`.** It is public, not experimental
(`useComposer`, `PluginComposerApi` in the SDK's app types): inside a thread context a component's
writes land in that thread's draft — the composer the popover sits on, and the thread a side-panel tab
belongs to. `updateText` puts `/name ` first (a slash command runs only at the start of a message) and
keeps the draft after it; then `focus()`. The button is offered only when `composer.scope` is this
thread's (`writesToThread`). After it, the panel calls `toThread` (which brings the composer back over
the panel on a narrow window), and the popover closes and stops Radix handing focus back to its
trigger, or the trigger would take it from the composer.

**Bodies render through bb's `Markdown`, images as links.** The host component loads images as it
draws them and gives no say over it, and a skill someone else wrote can carry a remote image, so
`app/markdown.ts` drops the `!` from every image outside fenced code.

## Invariants

- **`read` takes an id discovery produced for that thread, never a path.** It is the plugin's security
  boundary: the app names a thread and an id, the server resolves the provider and directory itself,
  and the id is looked up in a fresh scan (`host/discover.ts`) or in bb's list for that thread
  (`server/skills.ts`). Both sides have tests that try paths, crafted ids, another provider's id and
  another provider's bb row.
- **Codex reads `.agents/skills` before `.codex/skills`**, in every directory from the thread's
  directory to the repository root, then `~/.agents/skills`, `$CODEX_HOME/skills`, `/etc/codex/skills`.
  Paseo's own `listCodexSkills` was stale on this; do not "fix" the resolver to match anything but
  Codex's docs.
- **Deduplication is first-wins**, in precedence order, everywhere: within a resolver, then
  discovery before bb's list, the provider's plugins before bb's own skills, and every listed name out of
  the reported list.
- **Claude plugin scope keys on `projectPath`, not on `scope`.** Real manifests carry `scope: "local"`
  entries that are per-project. An entry with a `projectPath` applies inside it (or inside a worktree
  of it); one without applies everywhere.
- **Never apply `unquote()` to block-scalar continuation lines** in `shared/frontmatter.ts`. Block
  scalar content is literal YAML, quotes included.
- **The source kinds are one list**, `SOURCE_KINDS` in `shared/skills.ts`, in precedence order. The
  type, the zod enum and the browser's group order all read it. In Paseo they were three copies that
  had to be kept in step; keep them one.
- **The app imports the SDK root, the server and both contracts as types only** (`app/imports.test.ts`).

## Dropped from Paseo

Invoke (`client/invoke.ts`, the send and its re-entrancy guard, the arguments field) — see *Add to
chat, not invoke*. The agents observation (`client/agents.ts`) and the pill registration loop — bb
mounts the composer action itself, per composer. `agent.commands()` detection (`supportsCommands`,
`available`): bb's command list is typed. The popover's size caps and `detailLines` — the popover is ours and scrolls
itself. `host-imports.test.ts`, `sdk-types.ts`, React Native, `copyText` (the browser's clipboard
API works in every bb client) and react-query (each surface holds one small fetch).

## Limitations

- **Built-in skills carry no detail.** A skill compiled into an agent binary, or one bb's command list
  reports that no scanned directory or bb row holds (Codex's bundled system skills, Hermes's bundled
  ones), has a name, a description and an argument hint — no path, no body.
- **`source` is the provider's guess.** The two built-in sections split on it, as bb's `/` menu does.
- **`CODEX_HOME` and `HERMES_HOME` are the host daemon's.** The host worker reads the environment bb's
  host daemon passed it, not the agent's, so a per-provider or per-project override moves nothing. A
  Hermes agent run with `--profile` gets its profile's skills usable but not listed.
- **Hermes scopes beyond the home, `_org` mirrors and nesting below two levels are not read** — the
  Paseo limitations, unchanged.
- **Claude's `enabledPlugins` is not read.** An installed plugin that a project's settings switch off
  is still listed.
- **Disabled Codex skills appear** (`[[skills.config]]` in `~/.codex/config.toml` is not read), and
  **shadowed copies are hidden**, though Codex shows both copies of a name.
- **When bb and the provider both have a skill of one name**, the provider's copy is listed; which one
  the agent actually loads is not documented by either.
- **`user-invocable: false`** is read from scanned files only (such a skill gets no Add to chat); bb's
  rows are assumed invocable.
