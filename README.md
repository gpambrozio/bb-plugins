# bb-plugins

Plugins for [bb](https://getbb.app). One folder per plugin, each self-contained.

These are ports of the plugins in [`gpambrozio/paseo-plugins`](https://github.com/gpambrozio/paseo-plugins).
Each port is tracked by its own issue.

| Plugin | What it does | Status |
| --- | --- | --- |
| `skills` | Lists the skills a thread's agent can use, renders each `SKILL.md`, and invokes it. | [Not started (#1)](https://github.com/gpambrozio/bb-plugins/issues/1) |
| [`github-board`](github-board) | Your GitHub issues, pull requests and discussions on one sidebar board. | [Ported — 0.1.0 (#2)](https://github.com/gpambrozio/bb-plugins/issues/2) |
| [`launchd-jobs`](launchd-jobs) | Schedules shell commands on your Mac through launchd. | [Ported — 0.1.0 (#3)](https://github.com/gpambrozio/bb-plugins/issues/3) |
| [`herald`](herald) | Speaks one sentence when an agent needs you, and lists what is waiting. | [Ported — 0.1.0 (#4)](https://github.com/gpambrozio/bb-plugins/issues/4) |
| `model-pricing` | What every model costs, across five providers, in one table. | [Not started (#5)](https://github.com/gpambrozio/bb-plugins/issues/5) |
| [`firstmate-crew`](firstmate-crew) | Talk to one first mate; it runs a crew of agents in their own worktrees. | [Ported — 0.1.0 (#6)](https://github.com/gpambrozio/bb-plugins/issues/6) |

## Install

Each plugin releases from its own tags, `<id>/vX.Y.Z`. Install one and follow its compatible releases:

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@^0.1.0' --plugin firstmate-crew --tag-prefix firstmate-crew/
```

Plugins listed in the BB Community marketplace also install from bb's Plugins page, or with
`bb plugin install <id>@bb-community`. Each plugin's README has its details.

See [`AGENTS.md`](AGENTS.md) for how the plugins are built and released.

## License

[MIT](LICENSE)
