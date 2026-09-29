# bb-plugins

Plugins for [bb](https://getbb.app). One folder per plugin, each self-contained.

These are ports of the plugins in [`gpambrozio/paseo-plugins`](https://github.com/gpambrozio/paseo-plugins).
Each port is tracked by its own issue.

| Plugin | What it does | Status |
| --- | --- | --- |
| `skills` | Lists the skills a thread's agent can use, renders each `SKILL.md`, and invokes it. | [Not started (#1)](https://github.com/gpambrozio/bb-plugins/issues/1) |
| `github-board` | Your GitHub issues, pull requests and discussions on one sidebar board. | [Not started (#2)](https://github.com/gpambrozio/bb-plugins/issues/2) |
| `launchd-jobs` | Schedules shell commands on your Mac through launchd. | [Not started (#3)](https://github.com/gpambrozio/bb-plugins/issues/3) |
| `herald` | Speaks one sentence when an agent needs you, and lists what is waiting. | [Not started (#4)](https://github.com/gpambrozio/bb-plugins/issues/4) |
| `model-pricing` | What every model costs, across five providers, in one table. | [Not started (#5)](https://github.com/gpambrozio/bb-plugins/issues/5) |
| `firstmate` | Talk to one first mate; it runs a crew of agents in their own worktrees. | [Not started (#6)](https://github.com/gpambrozio/bb-plugins/issues/6) |

## Install

Nothing is published yet. From a clone:

```bash
bb plugin install path:/path/to/bb-plugins --plugin <id>
```

See [`AGENTS.md`](AGENTS.md) for how the plugins are built.

## License

[MIT](LICENSE)
