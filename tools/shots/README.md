# Plugin screenshots

Screenshots and demo GIFs of a plugin, taken from a throwaway bb on this Mac. The run spends no model
tokens and needs nobody's help, and nothing in the shots comes from your real data.

```bash
cd tools/shots
npm ci --cache "$TMPDIR/npm-cache"   # once; playwright-core only
npm run shots -- skills              # writes skills/docs/screenshots/
```

A run:

1. starts a dev bb;
2. seeds it;
3. installs the plugin from its folder;
4. runs `<plugin>/shots/shots.mjs`;
5. copies what the shot list made into `<plugin>/docs/screenshots/`.

The copy happens only if every shot succeeded, so a failed run leaves the old images alone. The dev bb
is stopped and its folder deleted on success, on failure and on Ctrl+C. `skills` takes about 30 s,
`launchd-jobs` about 35 s and `herald` about 50 s.

| Option | Effect |
| --- | --- |
| `--out <dir>` | Write somewhere else, e.g. a scratch folder to look before replacing the README images. |
| `--keep` | Leave the dev bb running at `http://127.0.0.1:48896` to explore it; `npm run shots -- --stop` stops it. |

A failed run prints the error and saves what each open page showed to `$TMPDIR/bbss-failures/`.

## Prerequisites

The run checks these first and says what is missing:

- **bb.app** in `/Applications`. The dev bb is the `bb-app` launcher inside it (`SHOTS_BB_APP`
  overrides the path).
- **A headless Chromium** in Playwright's cache. The run takes the revision the pinned `playwright-core`
  expects, or else the newest one cached. If there is none, run `npx playwright-core install
  chromium-headless-shell`, or set `SHOTS_CHROMIUM` to a `chrome-headless-shell` binary.
- **ffmpeg** (`brew install ffmpeg`), only for shot lists that record video. Playwright records with its
  own ffmpeg build at a pinned revision. If the cache lacks that revision, the run links Homebrew's
  ffmpeg in a private browsers folder under the dev bb's root; the shared cache is never written to.
- **The plugin's `node_modules`.** The run does an `npm ci` if they are missing, because bb builds the
  plugin from its folder.

## What the dev bb is

- **Its own server.** It runs from `bb-app.js --data-dir $TMPDIR/bbss/data --server-port 48896
  --host-daemon-port 48897 --no-in-app-updates --bundled`, and is not signed in, so it has no Connect
  and no bb cloud. Keep the root short: the data dir holds Unix sockets. `SHOTS_ROOT`,
  `SHOTS_SERVER_PORT` and `SHOTS_DAEMON_PORT` move it. The run refuses the owner's ports
  (38886/38887) and `~/.bb`.
- **A built environment, not an inherited one.** No `BB_*` variable, token or API key reaches it.
  Inside a bb thread, any `bb` re-execs the live one through `BB_CLI`, so this matters. Its HOME is a
  fake one under the root, so `~/.claude/skills`, `~/Library/LaunchAgents` and the like are the
  fixtures. PATH is the system's plus a private `bin/` holding only `node` and the stubs below, so the
  agent CLIs in your own tool folders are not on it. `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` point
  at a closed port.
- **Its stubs come first.** bb gives its tools and host workers a login shell's PATH, and macOS's
  `path_helper` (in `/etc/zprofile`) puts `/bin`, `/usr/bin` and Homebrew in front of the PATH it was
  given, so a stub in `bin/` would lose to the real tool. The fake HOME's `.zprofile` and `.zshrc` put
  `bin/` back in front, and the start fails unless `zsh -lc` and `zsh -lic` both find every stub there.
- **A stub `launchctl`, always.** `launchctl-stub.mjs` keeps a launchd of its own in `launchd.json`
  under the root (`seed.launchd`) and logs every call (`seed.launchctlCalls()`). It answers `print`,
  `print-disabled`, `bootstrap`, `bootout`, `enable`, `disable` and `kickstart` against `gui/<uid>`
  and fails anything else; `kickstart` counts a run and runs nothing. The real launchd is never asked.
- **Its machine is renamed "Studio Mac".** Otherwise it would carry this Mac's real name.
- **Two providers, neither real:**
  - `acp-demo`, the default and first in order, is `scripted-acp-agent.mjs`. This Agent Client Protocol
    agent replays the shot list's `turns`, so a thread gets content in under a second. A turn can end
    in a `permission` request the thread then waits on, or fail with an `error`. bb hands it no MCP
    tools, so plugin tools cannot be called from its turns: seed the plugin's state instead.
  - `claude-code` sees `claude-stub.mjs` as its CLI. The stub answers `--version` and the `initialize`
    handshake bb reads models from, so the composer shows Claude Code with its skills. A one-shot
    `claude -p` (a plugin's helper call, such as Herald's sentence writer) gets the first canned reply
    from `seed.claudePrint` whose `match` finds its prompt, as text or as Claude Code's JSON result. It
    exits with an error on anything else, so no Claude Code session or model call can run.

  Every other provider bb finds (Codex, Pi, ACP agents) is disabled. Do not loosen this: the scout
  found signed-in CLIs (omp, Hermes) visible from the dev bb when PATH was inherited, and one became
  the default provider.
- **Nothing is sent from the browser.** Every page refuses non-GET requests that would start a thread
  or send, edit, retry or queue a message, and the run fails if one is tried. Threads come from the
  seed (`seed.thread`), which spawns only on `acp-demo`.
- **Stopping kills only its own PIDs.** It stops the launcher and the processes below it, found by
  parent PID and never by name. A process still listening on a dev port is stopped only if its command
  line names the run's data dir. `bb-app stop` is never used: it takes no data dir and could address
  the owner's bb.

## Writing a shot list

`<plugin>/shots/shots.mjs` is an ES module with up to three exports:

```js
import { skillFile } from "../../tools/shots/lib/seed.mjs";

export const turns = [{ match: "changelog", reply: "I added an entry.", tools: [{ title: "Edit CHANGELOG.md", kind: "edit" }] }];

export async function seed({ bb, seed }) {
  seed.homeFiles({ ".claude/skills/review-pr/SKILL.md": skillFile("review-pr", "Review a pull request.") });
  const project = seed.project("Acme Web", { "README.md": "# Acme Web\n" });
  await seed.thread({ projectId: project.id, title: "Update the changelog", prompt: "Add a changelog entry" });
}

export async function shoot({ shots, VARIANTS }) {
  const page = await shots.page(VARIANTS.desktopDark);           // past the setup screen
  await shots.still(page, "page-dark.png", { around: [page.locator("form")] });
  await shots.closePage(page);
  await shots.video("demo", VARIANTS.desktopLight, async (page) => { /* act */ }, { formats: ["gif"] });
}
```

- **`seed`** (`tools/shots/lib/seed.mjs`) offers:
  - `homeFiles` (into the fake HOME);
  - `project` (a git repo with one commit, plus its bb project);
  - `thread` (spawns on `acp-demo` and waits for the turn; `until: THREAD_EVENTS.interaction` with
    `permissionMode: "accept-edits"` for a turn that asks a permission, which bb approves by itself
    otherwise) and `send` (another prompt to such a thread);
  - `rpc(pluginId, method, input)` (a plugin's RPC, to read its state or wait for it);
  - `claudePrint` (`claude -p`'s canned replies), and `launchd` and `launchctlCalls` (the stub launchd);
  - `installPlugin`.

  `skillFile` and `writeTree` are exported for fixtures. `bb.cli([...])` and `bb.cliJson` run the dev
  bb's CLI. Keep fixtures in the shot list as data rather than as files in the repo: a checked-in
  `.claude/skills/*/SKILL.md` would be picked up by agents working in this repository.
- **`shots`** (`tools/shots/lib/browser.mjs`) offers:
  - `page(variant, path)`;
  - `still(page, file, { around | clip, pad })`, where `around` crops to the union of the locators;
  - `video(base, variant, act, { formats, gifWidth, fps })`;
  - `closePage`.

  `VARIANTS` has light and dark at 1280×800 (2×) and 390×844 phones (3×). bb follows the system theme,
  so `colorScheme` is all dark mode needs.
- **The privacy gate** runs before every still and while a video records. It fails the run if the
  page's text holds any of:
  - your home path, or any `/Users/` path;
  - the user or machine names;
  - git's global name or email;
  - `SHOTS_DENY` (comma-separated: other machines' names, real project names).

  The terms are read at run time, so no real name is written here. It reads text, not pixels: an
  image's content is not checked.
- Output files go to `<plugin>/docs/screenshots/`, which no plugin's `files` list packages. Check with
  `npm pack --dry-run` in the plugin folder if you add a new output location.

## What the scout learned about the dev bb

- **The first-run screen** has a *Skip setup* button; `shots.page` presses it.
- **Provider pickers have no accessible names.** Use bb's own Alt+P (cycle provider) and read the
  model picker (`Provider, model and reasoning`), as `skills/shots/shots.mjs` does.
- **bb's nav rail has a "Skills" button too.** Match a plugin's control by its full accessible name
  (the Skills plugin's is `Skills: <count>`, which also waits for its first answer).
- **Headless video has no cursor.** Pace a demo with `waitForTimeout` and `pressSequentially` so a
  viewer can follow.
- **The plugin is installed before `seed` runs.** A plugin that reads fixtures on a poll sees them
  late; `bb.cli(["plugin", "reload", id])` at the end of the seed makes it read them at once, as
  `launchd-jobs/shots/shots.mjs` does.
- **Opening a thread in the browser marks it read.** Shoot a page that lists unread threads first, or
  mark one unread again with `bb.cli(["thread", "unread", id])`.
- **Panels need a thread.** A thread on `acp-demo` has a real worktree and panel tabs. A thread on any
  other provider would run that provider, so the harness has no way to make one.
