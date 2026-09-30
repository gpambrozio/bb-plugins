# AGENTS.md

A bb plugin that shows GitHub work in four columns — Issues, Draft PRs, Open PRs and Discussions —
and sends a card to a new agent thread. It is a port of
[`paseo-plugins/github-board`](https://github.com/gpambrozio/paseo-plugins/tree/main/github-board)
0.9.2; that plugin's `AGENTS.md` is the long record of why each behaviour is the way it is, and this
file carries over the parts that still hold. The repo root `AGENTS.md` covers what every plugin here
shares.

**The port is in progress** ([issue #2](https://github.com/gpambrozio/bb-plugins/issues/2)). What
exists is the logic that does not depend on three open decisions — where `gh` runs, how a card finds
its bb project, and which new-thread UI the send uses. `server.ts` and `app.tsx` are placeholders
until then.

## Orientation

| File | What it owns |
| --- | --- |
| `server/github.ts` | Every GitHub GraphQL query and how its answer is read, over an injected `GitHubApi`. |
| `server/gh.ts` | `gh api graphql` as that `GitHubApi`: argument spelling, failure messages, `gh auth token`. |
| `server/image.ts` | The image fetch: redirects by hand, the token only to `github.com`, a timeout and a size cap. |
| `shared/board.ts` | The zod shapes of a board, a card, its details and comments. |
| `shared/settings.ts` | The default prompts, `normalizePrompts`, `templateFor` and `renderTemplate`. |
| `shared/image-host.ts` | Which image URLs the server fetches, and which get the token; used by both halves. |
| `shared/launch.ts` | A card's repository id (`<host>/<owner>/<name>`) and its new thread's title. |
| `shared/remotes.ts` | A git remote URL in the same `<host>/<owner>/<name>` form, for project matching. |
| `app/image-gate.ts` | Whether an image in a body may be requested yet, and the host its placeholder names. |
| `app/link.ts` | Which links the board hands to the opener: http and https only. |

## The `GitHubApi` seam

`server/github.ts` never spawns anything. Each function takes a `GitHubApi` — `graphql(query,
variables)` answering `data`, and `warn(message)` for the plugin log — so the transport is one small
module whichever way the first decision goes. Its contract: **any GraphQL error rejects the whole
request**, as `gh api graphql` does by exiting non-zero. An HTTP transport must throw on a non-empty
`errors` too, or the invariants below stop holding.

Variables are typed, not pre-spelled: `ghGraphqlArgs` turns a string into `-f`, a number into `-F`
and a list into repeated `-f name[]=`. Sending a string with `-F` would turn `true` or `42` into a
boolean or a number.

`server/github.test.ts` runs the real functions against a fake `GitHubApi` that answers by query
shape and records every request. It is where the invariants below are pinned; add to it when you add
a query.

## Invariants carried over

- **Three search requests per refresh**, as GraphQL aliases: each column's `author:`, `user:` and
  (for issues and pull requests) `assignee:` searches share one request, because GitHub ANDs
  qualifiers. `mergeItems` dedupes by node id, re-sorts and cuts to `limit`. Both pull request
  columns come from one search, split by `isDraft`.
- **Checks and branch status are separate requests**, after the search. A token without Checks
  access fails `statusCheckRollup`, and any GraphQL error fails the request, so asking inside the
  search would blank both pull request columns. Either failure costs only its pills and goes to
  `warn`. Checks are asked for open pull requests only; branch status for drafts too.
- **Branch status compares the base ref against the head's SHA**, not its name, so fork pull
  requests resolve. `canUpdate` is `viewerCanUpdateBranch`, narrowed by conflicts and by
  `behindBy > 0`. `updateBranch` looks again before merging and sends nothing if the look says no;
  a success is taken at its word for `BRANCH_UPDATE_SETTLE_MS`, through `settleBranches`, run after
  the board's last `await` and before it is cached.
- **Every column carries its own `error`**, and a board with a failed column is not cached.
- **`@me` is resolved to a concrete login first** (`resolveViewerLogin`), because GitHub's search
  types disagree about the alias.
- **Images:** decided on what `new URL` parses, never on the text; a backslash, whitespace, control
  character, userinfo or non-default port is refused. The token goes only to `https://github.com`;
  redirects are followed by hand, at most five, each hop re-validated and given the token only if it
  is `github.com` again. The whole fetch — the token lookup included — has a 20-second timeout, and
  the body is read in chunks and abandoned at 4 MiB whatever `content-length` claimed. An image from
  any other host is requested only after the user taps it (`app/image-gate.ts`), and links open only
  when they are http or https (`app/link.ts`).
- **Prompts:** blank means inherit, at both levels, applied at the save boundary
  (`normalizePrompts`); an override stores only what it overrides; an unknown placeholder is left
  standing.

Still to carry over with the wiring: a provider without a selectable model is dropped from the
send dialog, and the dialog refuses to close while the prompt is being edited.

## Dropped from the Paseo plugin

`server/data-dir.ts`, the legacy settings handshake (`board.legacy-settings*`),
`server/host-imports.test.ts`, `server/sdk-types.ts` and `client/web.ts` platform gating — Paseo
packaging and migrations with nothing to migrate here. `isDefaultPrompts` and `completePrompts` only
served that migration.
