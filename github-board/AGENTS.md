# AGENTS.md

A bb plugin that shows GitHub work in four columns — Issues, Draft PRs, Open PRs and Discussions —
and sends a card to a new agent thread. It is a port of
[`paseo-plugins/github-board`](https://github.com/gpambrozio/paseo-plugins/tree/main/github-board)
0.9.2. That plugin's `AGENTS.md` is the long record of why each behaviour is the way it is; this file
carries over what still holds and says what bb changed. The repo root `AGENTS.md` covers what every
plugin here shares.

## Orientation

| File | What it owns |
| --- | --- |
| `server.ts` | Wiring: the login setting, finding `gh`, the project index, storage, realtime and the `send` spawn. |
| `server/service.ts` | What each RPC does, and the per-load caches it shares; driven by fakes in its tests. |
| `server/github.ts` | Every GitHub GraphQL query and how its answer is read, over an injected `GitHubApi`. |
| `server/gh.ts` | `gh api graphql` as that `GitHubApi`: finding `gh`, argument spelling, failures, `gh auth token`. |
| `server/image.ts` | The image fetch: redirects by hand, the token only to `github.com`, a timeout and a size cap. |
| `server/projects.ts` | Which bb projects a repository belongs to, and which one a card opens on. |
| `shared/contract.ts` | The RPC contract, the realtime channels, and the stored shapes (display prefs, launch defaults). |
| `shared/board.ts` | The zod shapes of a board, a card, its details and comments. |
| `shared/settings.ts` | The default prompts, `normalizePrompts`, `templateFor` and `renderTemplate`. |
| `shared/image-host.ts` | Which image URLs the server fetches, and which get the token; used by both halves. |
| `shared/launch.ts`, `shared/remotes.ts` | A card's and a git remote's repository id (`<host>/<owner>/<name>`); a new thread's title. |
| `app.tsx` | The nav panel, the settings section, and two palette commands. |
| `app/board-panel.tsx` | The page: toolbar, columns or tabs, the detail panel and the send dialog. |
| `app/state.ts` | The board (with its module-scope copy), display prefs and prompts, each kept current by realtime. |
| `app/board-logic.ts` | What the board draws: filter, issue folding, empty columns, pill wording. Pure and tested. |
| `app/card.tsx`, `app/pills.tsx`, `app/label-menu.tsx` | A card, its pills, and its right-click label menu. |
| `app/detail-panel.tsx` | The opened card: body, comments, actions, and the resize handle. |
| `app/markdown-parse.ts`, `app/html.ts`, `app/markdown.tsx` | The body renderer — see *Bodies and images*. |
| `app/image-gate.ts`, `app/remote-image.tsx` | Whether an image may be requested yet, and the component that asks. |
| `app/send-dialog.tsx` | Send to chat: bb's new-thread composer in a dialog. |
| `app/prompt-settings.tsx` | The template editor, on the settings page and behind the board's gear. |

## Where things run

**`gh` runs from `server.ts`, on the bb server's machine**, with the user's own `gh` login — no
`bb.host` entry and no token setting (owner's decision, issue #2). The board reads GitHub, not a
checkout, so no particular machine is needed. `findGh` tries `gh` on the PATH and then the two
Homebrew locations by path, because the server falls back to the PATH it was started with when the
login-shell lookup fails. A missing or signed-out `gh` calls `bb.status.needsConfiguration`, which
lasts until the next load — so the user reloads after fixing it, and the README says so. Every call
is killed after 30 seconds.

The only other subprocess is `git -C <path> remote -v`, for project matching, and it runs only on
project checkouts on the server's own machine (`primaryHostId`).

## The `GitHubApi` seam

`server/github.ts` never spawns anything. Each function takes a `GitHubApi` — `graphql(query,
variables)` answering `data`, and `warn(message)` for the plugin log. Its contract: **any GraphQL
error rejects the whole request**, as `gh api graphql` does by exiting non-zero. An HTTP transport would
have to throw on a non-empty `errors` too, or the invariants below stop holding.

Variables are typed, not pre-spelled: `ghGraphqlArgs` turns a string into `-f`, a number into `-F`
and a list into repeated `-f name[]=`. A string sent with `-F` that read `true` or `42` would arrive as
a boolean or a number.

`server/github.test.ts` and `server/service.test.ts` run the real functions against a fake `GitHubApi`
that answers by query shape and records every request. They pin the invariants below; add to them
when you add a query.

## Invariants carried over from Paseo

- **Three search requests per refresh**, as GraphQL aliases: each column's `author:`, `user:` and
  (for issues and pull requests) `assignee:` searches share one request, because GitHub ANDs
  qualifiers. `mergeItems` dedupes by node id, re-sorts and cuts to `limit`. Both pull request
  columns come from one search, split by `isDraft`.
- **Checks and branch status are separate requests**, after the search. A token without Checks
  access fails `statusCheckRollup`, and any GraphQL error fails the request, so asking inside the
  search would blank both pull request columns. Either failure costs only its pills and goes to the
  plugin log. Checks are asked for open pull requests only; branch status for drafts too.
- **Branch status compares the base ref against the head's SHA**, not its name, so fork pull
  requests resolve. `canUpdate` is `viewerCanUpdateBranch`, narrowed by conflicts and by
  `behindBy > 0`. `updateBranch` looks again before merging and sends nothing if the look says no; a
  success is taken at its word for `BRANCH_UPDATE_SETTLE_MS`, through `settleBranches`, which runs
  after the board's last `await` and before it is cached. The update is a merge with no
  `expectedHeadOid`.
- **Every column carries its own `error`**, and a board with a failed column is not cached.
- **`@me` is resolved to a concrete login first**: the login setting, else the `gh` account.
- **Images** are decided on what `new URL` parses, never on the text; a backslash, whitespace,
  control character, userinfo or non-default port is refused. The token goes only to
  `https://github.com`; redirects are followed by hand, at most five, each hop re-validated and given
  the token only if it is `github.com` again. The whole fetch — the token lookup included — has a
  20-second timeout, and the body is read in chunks and abandoned at 4 MiB whatever
  `content-length` claimed.
- **Prompts:** blank means inherit, at both levels, applied at the save boundary
  (`normalizePrompts`, on the server); an override stores only what it overrides; an unknown
  placeholder is left standing.
- **Edits patch every cache.** A label toggle or a branch update patches the server's cached board,
  and the server publishes `item-patched`, which every open board — and the app's module-scope copy —
  applies. That is also how an answer reaches a board remounted since the press.
- **The board draws** (`visibleColumns`): the filter first, then issues claimed by a pull request
  (drafts too) fold into it, then empty columns come off unless they errored — and if that leaves
  nothing, every column comes back.

## Bodies and images

bb's `Markdown` component is **not** used for bodies, on purpose: it takes only `content` and
`className`, so it gives no say over how a body's images load. Paseo's parser and HTML rewriter are ported instead (`app/markdown-parse.ts`,
`app/html.ts`, both pure) and `app/markdown.tsx` draws them, so every image in a body is either an
image block drawn by `RemoteImage` or a link. `RemoteImage` goes through `app/image-gate.ts`: a
GitHub-hosted image comes through the server (`loadImage`) at once; any other host waits for **Load
image**, because loading it tells that host the reader's address; an unreadable URL never loads. Links
go through `isOpenableLink` (http and https only) and bb's `UrlLink`.

## Project matching

A card's repository is matched to bb projects in `server/projects.ts`: first by each project's
`gitRemoteUrl` (its checkout's `origin`, recorded by bb, on every machine, no subprocess), then — only
for repositories no `origin` claimed — by every remote of checkouts on the server's machine, which
finds a fork's `upstream`. The same repository is often a separate bb project per machine, so a match
is a list; `preferredProject` picks one with a checkout on the server's machine, and the composer's
project picker lets the user switch. A miss retries against a freshly built index, so a project added
moments ago is found.

## Send to chat

`app/send-dialog.tsx` puts `experimental_NewThreadComposer` in a wide dialog. It waits for
`sendOptions` and the prompts before mounting the composer, because the composer re-seeds every
selection whenever a `default*` prop changes. Seeds: the matched project, the rendered template as
`initialPrompt`, and the last send's selections (`launch` in storage). The composer only resolves a
request; `send` on the server spawns it with the card's title and `pluginMetadata: { card }`, then
saves the selections — after the spawn, so a selection bb refused is not what the next card opens on.

The draft is kept per card (`draftKey`) and survives closing, so the dialog closes on every ordinary
dismissal; Paseo's refusal to close while the prompt was edited is moot. Providers without a
selectable model are the composer's to leave out.

Dropped from Paseo: the transcript row (`board-item` timeline card) — bb has no API for a plugin to
append a row to a thread's timeline; the card lives in the prompt and the thread's plugin metadata.
Also dropped: opening the card in a browser tab beside the new thread (`openUrl` follows the user's
in-app/external preference, so it could throw them out to a browser), and the host picker, which the
composer's environment picker replaces.

## Storage

| Where | What |
| --- | --- |
| `bb.settings` (host-rendered form) | `login` |
| `bb.storage.kv` `display` | `hiddenRepositories`, `detailWidthFraction` — toggled and dragged on the board, not form fields |
| `bb.storage.kv` `prompts` | The templates; edited by `app/prompt-settings.tsx`, normalised on save |
| `bb.storage.kv` `launch` | The last send's composer selections |

Each write publishes on its realtime channel (`shared/contract.ts`) so every window follows.

## Layout notes

- Wide: four columns side by side, each scrolling; the detail panel is the right part of the body over
  a blurred scrim that closes it. Its edge drags with pointer capture, so a drag that outruns the
  handle still moves it; the width is saved once, on release, as a share of the body.
- Compact (`useIsCompactViewport`): a tab per column with its count (`!` for an errored one), the
  selected tab kept at module scope; the panel is the whole body.
- The card's hover actions use `group-hover`, which Tailwind wraps in `@media (hover: hover)`, and
  are `pointer-events-none` until then — so on a touch screen a tap on that corner opens the card
  rather than pushing a commit through an invisible button.
- Colours are host tokens only: `text-destructive`, `border-warning`/`text-warning-text`,
  `text-primary`, `bg-state-hover`.

## Dropped from the Paseo plugin

`server/data-dir.ts`, the legacy settings handshake (`board.legacy-settings*`), `isDefaultPrompts`
and `completePrompts`, `server/host-imports.test.ts`, `server/sdk-types.ts`, `client/web.ts`, the
React Native keyboard and popover work, the hand-built send dialog and its pickers, and the
cross-host launch path.
