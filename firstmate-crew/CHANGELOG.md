# Changelog

Notable changes to `firstmate`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.9.0

### Added

- **No notification when the first mate only says "Captain, shipshape."** A new setting, off by default.
  When the first mate's whole reply is "Captain, shipshape.", its way of saying there was nothing to do,
  FirstMate marks the turn read, so bb does not notify you of it and it leaves no unread mark. Every other
  turn notifies as before, and your workers' notifications are not touched. If FirstMate cannot mark the
  turn read in time, you get the notification as you would have.

## 0.8.0

### Changed

- **Every worker is started with bb's Notify parent on Auto,** relaunches included, so a different
  default in your project or in bb cannot keep a worker's finished turns from the first mate.
- **A worker whose Notify parent you set to When stuck or Off is flagged on its card.** bb now offers
  the setting in every thread's menu, and either choice means the first mate is no longer told when that
  worker finishes. FirstMate does not change it back; the first mate's charter now tells it to check on
  such a worker itself and to tell you when it is waiting on one.

## 0.7.0

### Changed

- **Needs bb 0.47 or newer.** On an older bb this version is not offered as an update, and FirstMate
  stays on the version you have.
- **The board keeps itself up to date through bb.** A worker that moves to or from the first mate now
  appears on or leaves the board at once. The regular refresh runs once for all open boards, in every
  window, and stops when the last one closes, and after a dropped connection the board catches up on its
  own. On bb 0.48 a board you cannot see, because its panel is closed or another tab is showing, does not
  reload until you look at it again.
- **Autocompact waits as long as the provider's cache lasts, when bb knows.** bb can work out when a
  conversation's prompt cache expires (for Claude Code and Pi, above 100,000 tokens, with bb's "compact
  expired cache" experiment on). FirstMate then compacts at that moment instead of after your idle
  minutes, which still apply everywhere else.
- **A message to a thread that is due for autocompact compacts it first.** A watch note, your words from
  the board or the command line, or a steer to a worker, reaching a thread that FirstMate would compact
  right then, now has bb compact it and deliver the message once that is done, so the message does not
  pay for the whole expired conversation. If bb says it will not compact it then, the message goes as
  before; if the request fails in a way that leaves it unclear whether bb took it, you see the error
  rather than the message arriving twice.
- **Watches find their commands where bb finds its own:** your login shell's PATH, Homebrew,
  `~/.local/bin`, mise, asdf and Volta, so the pull request watch finds `gh` however bb was started.
- **Crew reasoning reads plainly in the settings:** "Leave it to the first mate", Low, Medium, High,
  Extra high and Max.
- The FirstMate tab has a ship for its icon.

### Added

- **The first mate links the exact message a worker reported in.** When it tells you what a worker
  found, finished or failed at, its message carries a link that opens the worker's thread at that
  message. It also rereads a single message rather than a worker's whole log. If you have edited your
  charter, the board offers the new one to compare, as for any charter change.
- **The first mate can start a worker with a model's own agent options**, such as a faster mode, the
  ones bb's model picker offers for that model.

## 0.6.0

### Added

- **Autocompact.** FirstMate can compact a conversation on its own once it has sat idle with a large
  context, so its next turn starts from a summary instead of sending everything again after the
  provider's cache has expired. It is off by default and set separately for the first mate and for the
  crew in FirstMate's settings: switch it on, and choose above how many thousand tokens (default 200,
  that is 200,000 tokens) and after how many idle minutes (default 60). A thread is never compacted
  mid-turn, with a message waiting, or while it waits on you, and once compacted it is left alone until
  it has run another turn. FirstMate compacts at most one thread a minute and notes each one in its log.
- **Compacting a worker wakes the first mate briefly.** The compaction is a turn of the worker's own,
  and bb tells the first mate about it like any other, with nothing new in it.

## 0.5.1

### Fixed

- **A crewmate can be started with any reasoning level its model offers.** FirstMate used to accept only
  a fixed set of levels and refused others that a model lists, such as "minimal". Now the first mate can
  pass any level, and bb says so plainly when the chosen model does not offer it. Asking for the level
  with nothing after it is refused rather than quietly falling back to the default.

## 0.5.0

### Changed

- **Needs bb 0.46 or newer.** On an older bb this version is not offered as an update, and FirstMate
  stays on the version you have.
- **The board asks bb less on every refresh.** It now reads what each worker is working on for the whole
  crew at once, instead of asking once per worker, so a large crew costs bb the same as a small one. The
  board shows the same cards as before.

## 0.4.0

### Added

- **Answer a held card from the board.** A card waiting on your call now shows a button for each answer
  the first mate expects, most likely first. Pressing one sends that answer to the first mate as if you
  had typed it, as a suggestion does. For any other answer, type it in the card's Answer box and press
  Send; the first mate gets it with the task's name in front. The first mate can put buttons on other
  cards too.
- The first mate's charter now tells it to write those likely answers for everything it holds for you,
  each one a complete request, to rewrite them as things change and to drop them once you have answered.
  If you have edited your charter, the board offers the new one to compare, as for any charter change.

## 0.3.0

### Changed

- **A suggestion you remove stays removed.** The trash on a suggestion card now also remembers it, and
  the board hides that suggestion if the first mate writes it again word for word. A suggestion whose
  words change, because something about it changed, shows as usual. Sending a suggestion by pressing
  its card is not counted as removing it.
- The first mate's charter now tells it to check what you removed before it rewrites its suggestions,
  never to suggest those again, and to start from its suggestion list as it is, since you may have
  removed or sent some. If you have edited your charter, the board offers the new one to compare, as for
  any charter change.

## 0.2.6

### Removed

- **Ahoy is gone.** The board no longer has an Ahoy button, the command palette no longer has
  FirstMate: ahoy, and the first mate's charter no longer has its ahoy section. Bearings is unchanged.
  If you have edited your charter, the board offers the new one to compare, as for any charter change.

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
