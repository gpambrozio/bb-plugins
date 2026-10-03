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
| `host/resolve/*` | Carried over from Paseo: Claude, Codex and Hermes search paths, the repo walk, one skills directory, ids; plus `read-bounded.ts`, the one way discovery reads a file. |
| `server.ts` | Binds the ports in `server/skills.ts` to `bb.sdk` and the host entry. |
| `server/skills.ts` | The two RPCs: thread → workspace, discovery + the skills taken from bb's list + the reported list, and `read`'s id boundary. |
| `server/reported.ts` | Splits bb's command list into skills and commands, minus every name already listed. |
| `shared/skills.ts` | Zod shapes, `SOURCE_KINDS`, first-wins dedupe. No SDK import: the app uses it at run time. |
| `shared/frontmatter.ts` | `SKILL.md` frontmatter. Used by the host and by the server (for bb's skills). |
| `shared/contract.ts`, `shared/host-contract.ts` | App ⇄ server and server ⇄ host contracts. The app imports them as types only. |
| `app/browser.tsx` | List, search, both detail screens, Add to chat — drawn by the panel and the composer popup. |
| `app/panel.tsx`, `app/composer-button.tsx`, `app/composer-popup.tsx` | The thread-panel tab; the composer button with its count; the list in bb's composer popup, which the button and the composer command toggle. |
| `app/use-skills.ts`, `app/answer-channel.ts` | The two RPC reads; the list shared by every surface showing one thread's skills. |
| `app/insert.ts` | Add to chat: the pill, where it goes in the draft, the text fallback, and which composers it may write to. |
| `app/markdown.ts` | Defuses a body's images and raw HTML, by parsing it, before bb's `Markdown` draws it. |

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

**Composer surfaces: an action, bb's popup and a composer command.** `app.composer.customize`
`actions` renders a component in the thread composer's toolbar, so the button is a component that runs
the list itself and shows the count; it is `Skills` without a number until the first answer. It
toggles the list in bb's own composer popup (`experimental_popups`, opened with
`useComposer().experimental_openPopup`, bb 0.45): bb places it like the mention menu, closes it on
Escape or a click outside, uses its own drawer on a narrow window, and gives the editor its focus back
when it closes. `experimental_closePopup()` answers whether one was open, which makes the toggle. A
composer command (`app.composer.experimental_registerCommand`, `browse`) toggles the same popup in the
composer that holds the caret; it has **no default key** (a clashing default is left unbound by bb, and
a key bb does not know of may belong to the system), so the user binds one in bb's keyboard settings,
and it is in the palette. Both APIs are experimental in bb 0.45; if they change, this is where.

Three things about bb's popup that only its source says (`ComposerPopupHost`, `PromptBoxInternal` at
desktop-v0.45.0), each with a test:

- **It is drawn inside the composer's `<form>`.** A button with no `type` submits the form, which sends
  the message, so every button the browser and the popup draw says `type="button"`.
- **A press in the form that is not on a control focuses the editor, and the editor's focus closes the
  popup.** The popup's root stops `mousedown` from reaching the form, so a press on a body, a heading
  or the scroll bar leaves it open. The root is also focusable (`tabIndex={-1}`): such a press would
  otherwise drop the focus on the page, out of the form that handles Escape. For the same reason it
  takes the focus back whenever the popup changes screen, which removes the row or back link that had
  it.
- **Its component mounts each time it opens.** The button and the popup are separate slots with no
  props between them, so they share their answers through `app/answer-channel.ts`: the popup opens on
  the list the button counted, its own scan (one per opening) refreshes both, and a thread's last
  answer is dropped once nothing shows it. Answers, failures included, are ordered by when they were
  asked for, so the button's slower first scan cannot overwrite the popup's newer one.

**Open in panel** calls `useBbNavigate().openThreadPanel({ actionId: "skills" })` after closing the
popup; the command palette entry opens the same tab. When the popup is showing a skill, **Open in
panel** passes it as the tab's `params` (`{ skill: { kind, id | name } }`, titled `Skills: <name>`),
and the panel opens on it (`selectionFrom` in `app/browser.tsx`; anything else in `params` opens the
list). bb persists `params` with the tab and opens a tab per distinct `params`, so each skill opened
this way is a tab of its own. Nothing patches the DOM.

**Add to chat, not invoke — the owner's decision.** The Paseo plugin (and issue #1's mapping) sent
`/name args` to the agent. This port has no Invoke, no arguments field and no send: its one action,
**Add to chat**, puts the skill's command at the start of the thread's message box and focuses it, so
the user adds arguments and sends the message themselves. Do not bring the send back without the
owner asking.

**Add to chat inserts bb's own command pill, through `useComposer()`.** `useComposer` is public, not
experimental: inside a thread context a component's writes land in that thread's draft — the composer
that opened the popup, and the thread a side-panel tab belongs to. `composer.replace` puts a
`{ kind: "command", trigger: "/", source, origin, argumentHint }` mention over `/name` at the start,
then a space, then the rest of the draft; then `focus()`. That is exactly what bb's `/` menu inserts
(`promptCommandResourceFromSuggestion`), so the message is the same `/name …` text it was, and a
provider that reads skill pills (Pi) gets one. A command pill already at the start is replaced, not
joined by a second — what bb's Plan and Goal rows and its bundled `automations` plugin do. `source` is
`skill` for a discovered skill and the reported list's own for a reported entry; `origin` is
`project` for a project or repository skill and `user` for the rest (as bb's own skill rows), and the
reported list's own otherwise, which is why the server passes it through. A name with whitespace in it
cannot be a pill (the pill stands for `/name`), so it goes in as `/name ` text, replacing a leading
command pill all the same. `replace` takes text and mentions together and does not rebase mention ranges, so
`withSkillCommand` (`app/insert.ts`) shifts every other mention by what it added before it. It passes
no `attachments`, which leaves the draft's own in place. `replace` is new in SDK 0.6 (bb 0.45), which
is why this plugin needs bb 0.45. The button is offered only when `composer.scope` is this thread's
(`writesToThread`). After it, the panel calls `toThread` (which brings the composer back over the panel
on a narrow window), and the popup closes, bb handing the editor its focus.

**Bodies render through bb's `Markdown`, with nothing in them that loads — conservatively.** The host
component loads images as it draws them and gives no say over it, and a skill someone else wrote can
carry a remote image or raw HTML; its body must also never hang or crash the surface. Three review
passes found ways around anything precise, so `app/markdown.ts` is deliberately blunt:

- **Budgets before parsing**, as raw character counts no syntax can hide from: at most 48 KiB, 512
  `[`, 4,096 `*`/`_`, and 32 blockquote or list markers opening any one line. The parser (bb's
  renderer's too) is quadratic in nested image labels and in mixed emphasis runs, and overflows the
  stack on thousands of nested containers. A body past any budget is shown whole as a fenced code
  block, unparsed. Real skills sit far below every budget (on one machine, 9 of 1,398 `SKILL.md` files
  are over 48 KiB, and none come near the others).
- **One parse, one walk** (mdast with GFM, as bb parses): every image, image reference and HTML node —
  comments included — is replaced, by its position, with literal text: every ASCII punctuation mark
  escaped, line breaks folded. An image becomes `\[alt\]`, never empty, so it cannot join a
  neighbouring `!` or `[` into new syntax. Its source is left out on purpose: a reference image would
  copy its definition's URL into every use and blow the body far past the size budget. Every
  replacement comes from the span it replaces, so the output is at most twice the input.
- **Any throw** shows the body as the same fenced block.

Tests re-parse the output and assert no image or HTML node is left, and time the hostile payloads from
the reviews. Do not loosen this into pattern matching or re-parsing loops; each was a review finding.

## Invariants

- **`read` takes an id discovery produced for that thread, never a path.** It is the plugin's security
  boundary: the app names a thread and an id, the server resolves the provider and directory itself,
  and the id is looked up in a fresh scan (`host/discover.ts`) or in bb's list for that thread
  (`server/skills.ts`). Both sides have tests that try paths, crafted ids, another provider's id and
  another provider's bb row.
- **`read` serves the bytes discovery validated; it never opens the path again.** The scan keeps
  each body with its entry (`ScannedSkill`, host-only — `discover` strips it), so a `SKILL.md` swapped
  for a symlink between the scan and the read changes nothing (`host/discover-race.test.ts`).
- **Every file discovery reads that a workspace can plant goes through `readBoundedText`**:
  `SKILL.md`, a worktree's `.git` and `commondir`, and Claude's plugin manifest. It opens non-blocking,
  checks on that descriptor that it is a regular file, and stops past a byte cap (`SKILL.md`: 1 MiB),
  so a FIFO, a device or a huge file is skipped instead of hanging or filling memory. A scan has no
  cancellation; it does not need one once every read is bounded.
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
`available`): bb's command list is typed. Paseo's popover size caps and `detailLines` — bb's popup scrolls
what it is given. `host-imports.test.ts`, `sdk-types.ts`, React Native, `copyText` (the browser's clipboard
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
