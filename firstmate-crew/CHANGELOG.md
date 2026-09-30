# Changelog

Notable changes to `firstmate`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

The first release: FirstMate for bb, ported from the Paseo plugin of the same name.

### Added

- **One first mate, and a crew it runs.** Launch a first mate from FirstMate's settings, or adopt a
  thread you already started in its home folder. It appears pinned in the sidebar, and you talk to it in
  bb's own chat. Give it a task and it sends a worker to do it, each in its own worktree of your project,
  shown under the first mate in the sidebar. It brings back finished branches and pull requests, findings, and the decisions
  that are yours, and never merges without your word unless you have said a project may.
- **A board of the crew** on the first mate's FirstMate tab: Queued, Working, Blocked, Parked, Done,
  Failed and Idle, with each worker's last word, a link to its pull request, and any decision it is
  waiting on you for. Sections fold and stay folded, and arrows move them into the order you want. On a worker's own thread the tab shows that worker's
  card, and on a thread working in the home it offers to adopt the thread as the first mate.
- **Steer, Interrupt, Relaunch and End on each card**, and, on a worker's own thread, a note box that
  tells the first mate something about it. Ending a worker whose task is not done asks first, because
  its worktree is removed after a grace period.
- **Bearings and Ahoy**, as buttons and in the command palette: where everything stands, and what
  happened since you last spoke, with each open decision put to you in turn. A FirstMate: open entry goes
  to the first mate.
- **Suggested next steps**, one press away. The first mate offers what you will probably want next as
  buttons; pressing one sends it as if you had typed it, and the trash removes it.
- **Compact and Restart on the board.** Compact frees room in the first mate's conversation; Restart
  keeps the first mate's thread, its records and its running workers, and starts its conversation afresh.
  A gear beside them opens FirstMate's settings.
- **Watches**: small scripts that run on a schedule while bb is running and tell the first mate when
  they have something to say. A pull request watch is built in and reports merges, closes, reviews,
  comments and checks turning red or green within about five minutes, when `gh` is logged in. In chat a
  watch's message is one line naming the watch, with a chip that opens the whole message. A card lists
  the watches and switches them off or on.
- **The first mate's home**, `~/FirstMate` unless you choose another place: its charter, your standing
  orders, its backlog and its records, all plain files you can read and change. When FirstMate's charter
  changes and you have edited yours, the new one is put beside it for you to compare.
- **Settings** for the home, the model workers are started with and how often the board refreshes.
- A command to reach the first mate from a shell.

### Not in this version

- A chat, transcript and files view of its own: the first mate is a normal bb thread, and bb's chat and
  file panel do that work.
- A `/fm` slash command in the composer, which bb does not offer plugins.
- A first mate on another machine: the home and the watches are on the machine running bb.
