# Skills (skills)

Every skill a thread's agent can use, where each one comes from, and what it says — beside the
conversation, with a button to run one. Ported from
[`paseo-plugins/skills`](https://github.com/gpambrozio/paseo-plugins/tree/main/skills).

bb's own `/` menu lists skill names. This lists them per thread and by origin — the project, the
repository, your personal folder, an admin folder, a Claude Code or Codex plugin, or bb itself — and
opens each one's `SKILL.md`, rendered, with its path. Claude Code, Codex and Hermes threads get their
skill files read off disk, in the order that provider reads them, so the copy listed is the copy the
agent uses. Threads on any other provider list bb's own skills and what bb's `/` menu reports for them.

## What you need

- bb 0.44 or later.
- Nothing else: no account, key or network access. The plugin reads skill files on the machine the
  thread runs on, through bb's host daemon there.

## Install

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@^0.1.0' --plugin skills --tag-prefix skills/
```

## Use

- **The Skills button** in a thread's composer shows how many entries the thread has. Press it for a
  popover (a sheet in a narrow window) listing them: search, pick one to read it, type any
  arguments and press **Invoke** or **Insert in chat**. **Open in panel** opens the full tab.
- **The Skills tab** in the thread's side panel (from the panel's launcher, or *Skills: show this
  thread's skills* in the command palette) shows the same list, and each skill's path with **Copy
  path** and its whole `SKILL.md`.
- **Invoke** sends `/name arguments` to the thread. If the agent is busy, it waits in the queue.
- **Insert in chat** puts `/name arguments ` at the start of the thread's message box instead, without
  sending it, and puts the cursor there — to add more before sending. Anything already typed stays,
  after the command.

Skills are grouped by where they come from, in the order the provider reads them. A name defined in
two places is listed once, under the copy that wins. **Built-in skills** and **Built-in commands** are
what bb's `/` menu offers that no file was found for; they have a description and can be invoked, but
have no file to show.

## Develop

```bash
npm install --include=dev
npm test               # vitest: resolvers, the RPCs and the id boundary, the app
npx tsc --noEmit
bb plugin build
bb plugin install path:$PWD --yes
bb plugin dev          # rebuild and reload on change
bb plugin logs skills -f
```

`AGENTS.md` records why the plugin is shaped this way, what it adds to bb's own skill management, and
what it deliberately does not do. Read it before changing discovery.

## Layout

| Path | Owns |
| --- | --- |
| `host.ts`, `host/` | Discovery on the thread's machine: the provider resolvers and `read`. |
| `server.ts`, `server/` | Thread → workspace, bb's own skills, the reported list, the RPCs. |
| `shared/` | Shapes, frontmatter, and the two contracts. |
| `app.tsx`, `app/` | The panel, the composer button and popover, and the browser they share. |

## License

[MIT](../LICENSE)
