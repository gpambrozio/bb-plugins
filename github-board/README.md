# GitHub Board

A board of your GitHub work inside bb, and a button that hands any of it to an agent thread. Ported
from [`paseo-plugins/github-board`](https://github.com/gpambrozio/paseo-plugins/tree/main/github-board).

Four columns — **Issues**, **Draft PRs**, **Open PRs** and **Discussions** — covering what you wrote,
whatever is open on repositories you own, and what is assigned to you anywhere.

- An issue that an open pull request closes folds into that pull request's card, as an `Issue #12` pill.
- Open pull requests show their CI checks (`✓ 9 ✕ 1 ● 2`). A branch behind its base shows **Out of
  date**, or **Conflicts**, with an **Update branch** button wherever GitHub itself offers one.
- Press a card for the detail panel: the body, state, dates, assignees and branches, the comments on
  request, and **Open on GitHub**. Images from GitHub load, private ones included; an image from any
  other host waits until you press **Load image**, since loading it tells that host you read the item.
- Right-click an issue or pull request card (or long-press it) to add or remove labels.
- **Send to chat** opens bb's new-thread composer with a prompt written for the card's column, in the
  bb project whose checkout has that repository as a remote. Pick the model, environment and project as
  you would for any thread; the next card opens with the same choices.
- A filter narrows the board to some repositories. It, and the detail panel's width, are remembered.

## What you need

- bb 0.44 or later.
- The GitHub CLI, [`gh`](https://cli.github.com), installed and signed in (`gh auth login`) **on the
  machine running the bb server**. The board uses that login; it stores no token of its own. Without it
  the plugin shows as needing configuration.
- For Send to chat to pick a project, a bb project whose checkout has the card's repository as a git
  remote — its `origin`, or (on the bb server's machine) any other remote, such as a fork's `upstream`.

## Install

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@^0.1.0' --plugin github-board --tag-prefix github-board/
```

The board is **GitHub Board** in the sidebar. The palette has *GitHub Board: open the board* and
*GitHub Board: edit prompt templates*.

## Settings

On the plugin's settings page:

- **GitHub login** — whose work the board shows. Blank means the account `gh` is signed in as.
- **Prompt templates** — what Send to chat opens with, one per column, with per-project overrides.
  Placeholders: `{url}`, `{title}`, `{number}`, `{repository}`. Clear a field to go back to the
  default. The gear on the board opens the same editor.

After installing or signing in to `gh` for the first time, run `bb plugin reload github-board`.

## Limitations

- `gh` runs on the bb server's machine. The fallback that finds a fork's `upstream` remote only looks
  at checkouts on that machine; a project checked out only on another machine is matched by its
  `origin` alone.
- Pull request review comments (on the diff) are not shown; the conversation is.
- A thread started from a card has no card row in its transcript, because bb has no way for a plugin to
  add one. The card is in the prompt and in the thread's plugin metadata.

## Develop

```bash
npm install --include=dev
npm test
npx tsc --noEmit
bb plugin build
```

[`AGENTS.md`](AGENTS.md) records the invariants this plugin keeps.

## License

MIT
