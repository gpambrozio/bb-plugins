# Changelog

Notable changes to `github-board`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

The first release: GitHub Board for bb, ported from the Paseo plugin of the same name (0.9.2).

### Added

- **A board of your GitHub work** in the sidebar: Issues, Draft PRs, Open PRs and Discussions, covering
  what you wrote, what is open on your own repositories, and what is assigned to you. On a narrow window
  the columns become tabs, each with its count.
- **One card per piece of work.** An issue that a pull request closes shows on the pull request's card
  instead of on its own.
- **Checks and branch status on pull requests**, with an Update branch button wherever you can push to
  the repository — including repositories that have "Always suggest updating pull request branches"
  off, where GitHub's own page, and the Paseo board, offered none. It looks again before updating, so
  a branch with conflicts is not touched, and a failed update says why on the card.
- **A detail panel** for each card, with its description, comments and images. Private images load;
  images from outside GitHub wait until you ask. The panel can be widened or narrowed by dragging its
  edge, and keeps that width.
- **Labels from a right-click menu**, applied as you press them.
- **Send to chat**, which opens bb's own new-thread composer on the card with a prompt for its column,
  in the project that has the card's repository checked out — including a fork, through its
  `upstream` remote. The next card opens with the same model and environment.
- **Prompt templates** per column and per project, on the plugin's settings page and behind the board's
  gear.
- **A repository filter**, remembered across windows.

### Changed from the Paseo plugin

- The send dialog is bb's composer, so the model, reasoning, environment, project and permission
  pickers are bb's own. A prompt you were editing is kept if you close the dialog.
- The board no longer adds a card row to the new thread's transcript; bb has no way for a plugin to add
  one. The card's details are in the prompt and stored with the thread.
- Sending a card to another machine is done through the composer's environment picker.
