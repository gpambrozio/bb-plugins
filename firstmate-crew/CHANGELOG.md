# Changelog

Notable changes to `firstmate`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.5

### Changed

- **A suggestion you send leaves the list.** Pressing a suggestion card still sends it to the first mate,
  and once the first mate has it, the card goes away as if you had trashed it. If the send fails, the card
  stays and the error shows as before. Only that suggestion is removed, even if the first mate has
  rewritten its list meanwhile.
- On a wide window the first mate's chat is already beside the board. On a phone the board stays open
  after a send, because bb gives plugins no way to close a thread's side panel; close it yourself to see
  the chat.

## 0.2.4

### Changed

- **Needs bb 0.45 or newer.** On an older bb this version is not offered as an update, and FirstMate
  stays on the version you have.
- **The first mate starts already pinned.** Launching one no longer has a separate pinning step, so it can
  no longer end with "started but could not be pinned".
- **The first mate knows what to do when bb cuts a worker short.** bb 0.45 tells it when a worker stops
  because its machine dropped or restarted, its setup failed before it began, or a message to it could not
  be delivered. The first mate now has the worker carry on, starts it again, or resends the message,
  instead of reading the worker's last, out-of-date status. bb says nothing when someone stops a worker by
  hand, so the first mate asks you before resuming one it finds stopped.

## 0.2.3

### Changed

- Built and tested against bb 0.45. Nothing you can see changes, and it still runs on bb 0.44.

## 0.2.2

### Added

- **Read a whole suggestion before sending it.** A suggestion too long for its card now has a chevron
  beside the trash. Press it to open the full request below the card, wrapped and ready to select and
  copy; press it again to fold it. Opening a card never sends it, and pressing the card itself sends it
  as before. It works with the keyboard and on a phone.

## 0.2.0

### Added

- **`/fm` in every thread.** Type `/fm` and a request in any thread, and that thread's agent hands the
  request to the first mate word for word, quotes and all, then says so in one line and leaves the work
  to it. The first mate sees which thread it came from, with the thread's project and branch, so "this"
  and "my work" mean that thread's. `/fm` on its own asks what to send, and agents never use it unless
  you type it. It works in threads on any machine bb reaches, for requests up to 12,000 bytes.

### Changed

- **Messages sent with the command that reaches the first mate from a shell are marked as relayed,**
  with the thread they came from when there is one. The first mate treats them as requests: it may start
  or steer work for them, but merging, anything destructive or irreversible, publishing, credentials and
  settings now wait for you to say so in the first mate's own chat.

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
  watch's message is one line naming the watch, with a chip that expands the whole message in place. A card lists
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
