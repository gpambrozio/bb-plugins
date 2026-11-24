# AGENTS.md — duo-rail

An app overlay (`app.slots.experimental_appOverlay`): a column of buttons in the iPhone Duo's side strip,
below the camera, on the folded cover screen and the unfolded display. And a settings section
(`app.slots.settingsSection`, "Buttons"), where the owner picks each display's buttons. Read the root
`AGENTS.md` first. Background: get-bb/bb#7507 (the strip, its measurements, and Apple's guidance) and the
scout report that proposed this plugin.

## Invariants

- **The show rule is `shared/placement.ts` and nothing else**: no top inset, an inset of at least 44 pt
  on exactly one side, whatever layout bb chose. It is pure and table-tested; change it there, with a row
  for the device you are adding or excluding. The SDK names no device, so the rule keys on insets, which
  is also how Apple says to tell layouts apart.
- **Which display is bb's layout** (`displayFor` in `shared/layout.ts`): compact (`(max-width: 767px)`,
  the vendored `useIsCompactViewport`) is the folded cover screen, wide is the unfolded display. Each has
  its own buttons and its own camera gap setting (`CLEARANCE_SETTINGS`, `DEFAULT_CLEARANCES`).
- **Insets come from CSS `env(safe-area-inset-*)`**, read through an invisible probe element
  (`app/insets.ts`), as bb's own layout reads them. bb's native bridge also carries insets, but it is bb
  internals. An overlay is not passed `isCompactViewport`.
- **The rail never covers or moves bb's interface.** bb pads its page out of the strip on both layouts, so
  the rail draws only inside the strip's width (`width` = the inset); the shot list checks that no bb
  control reaches into the unfolded strip. The column is `pointer-events: none` and only the buttons take
  taps. A menu trigger passes its own `className`; `RailButton` merges it, otherwise `pointer-events-auto`
  is lost and taps on a menu button fall through (a regression test covers it). On the wide layout a menu
  opens beside its button, into the page (`side` away from the strip); on compact it is bb's sheet.
- **Stacking: z-index 39.** bb's compact page is z 30, and every layer bb draws over it is 40 or higher:
  the sidebar drawer's transparent tap-to-close layer 40, the full-page tool panel 45, toasts 49, and
  dialogs, sheets and menus 50. bb's compact drawer slides the page sideways rather than covering it, so
  the rail also fades out while anything covers a button (`app/covered.ts`). That is a hit test
  (`elementFromPoint` at each button's centre, re-run on DOM mutations, resizes and transition ends) that
  names no bb element. The faded rail keeps its hit area, so the test sees when it is uncovered.
- **The layout is one JSON string setting, `layout`** (`shared/layout.ts`). Plugin settings hold only
  strings, numbers and booleans, and a setting lives on the bb server, reaches the app live through
  `useSettings()`, and is written from the app with `useSdk().plugins.updateSettings` — no RPC, no storage.
  `layoutSchema` (zod, no SDK import) is the contract: the server's `experimental_schema` refuses a layout
  that fails it, whoever writes it, and `parseLayout` turns a missing, empty or broken value into the
  default (today's Back, New thread, More) without throwing. Adding an action kind means a schema entry,
  `ACTION_CHOICES` / `newLeafAction` / `describeAction` in `app/editor-model.ts`, its fields in
  `app/editor.tsx`, and how it runs (`app/actions.ts`, or a component in `app/rail.tsx` when it needs
  hooks). Bump `version` in the layout only for a change an older app could not read.
- **Only SDK routes and web-platform calls.** New thread, a thread and a project are `useBbNavigate()`
  (`toCompose`, `toThread`, `toProject`), a URL is `openUrl`, the recent threads are
  `experimental_useSidebarThreads`, a thread-menu action is `experimental_useThreadActions` on the open
  thread (its target built from the sidebar row, `app/open-thread.ts`; the editor lists
  `experimental_useThreadActionRegistrations`), and Back, Forward and Reload are `history.back()`,
  `history.forward()` and `location.reload()`. bb's thread search, its sidebar drawer, its own pages,
  other plugins' pages and its command palette have no SDK route from an overlay
  (`experimental_useSidebarNavigation()` is empty outside the sidebar, `toPluginPanel` reaches only this
  plugin's own panels, and a plugin cannot run another's commands). Do not add them by clicking bb's
  buttons or sending its keyboard shortcuts.
- **A `bb` command runs in an SDK terminal** (`app/bb-command.ts`). bb has no call that runs a
  command-line command for a plugin, so the button creates a terminal on the server's machine
  (`terminals.create`, `host_path` on `system.config().primaryHostId`) running bb's installed launcher
  (`system.experimental_cliCommand().installedPath`) through a `sh` wrapper in argv mode: the words are
  never re-quoted, the exit status is printed inside an OSC sequence, and the wrapper then waits (`sleep
  120`) so the output can be read before bb drops the exited terminal. The app reads the output
  (`terminals.output`, `sinceSeq`), shows its last lines in a toast that replaces the "Running…" one (same
  `id`), and always force-closes the terminal; it gives up after a minute. In the dev bb,
  `bb settings cli-command install` links the launcher into the fake HOME only.
- **The camera gaps are settings** (`cameraClearance` folded, default 175; `cameraClearanceUnfolded`,
  default 110; 0–600) because the SDK gives no occlusion rects. `normalizeClearance` keeps a missing or
  broken value usable, falling back to that display's default.
- **The app never imports the SDK root at run time** (`app/imports.test.ts`). `shared/` imports only zod.

## Testing without a Duo

Chromium's `Emulation.setSafeAreaInsetsOverride` (a CDP command, reached through Playwright's
`newCDPSession`) sets `env(safe-area-inset-*)` on a page with `viewport-fit=cover`, as bb's is. bb then
pads itself as it does on the device. `shots/shots.mjs` uses it at 466 × 678 (folded, right 84) and
951 × 669 (unfolded, right 85, bottom 21) for the screenshots, and to check placement, the 44 pt targets,
taps reaching the buttons, hiding on a desktop and an ordinary iPhone, no bb control in the unfolded strip,
the drawer covering the rail, the buttons' navigation, and a layout saved in the editor: its Pin button pins
the thread, and its `bb --version` button's result comes back as a notice.

The SDK's app harness fakes `useSdk()` (`sdk`), thread actions (`threadActions`,
`threadActionRegistrations`) and settings, so `app/rail.test.tsx` and `app/editor.test.tsx` render the
real slots.

## Machine

Everything runs in the app; the server only defines the settings. A `bb` command runs on the bb server's
machine (`primaryHostId`), where bb installs its command-line tool. There is no `bb.host` entry.
