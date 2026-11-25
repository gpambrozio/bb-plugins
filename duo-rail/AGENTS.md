# AGENTS.md — duo-rail

An app overlay (`app.slots.experimental_appOverlay`): a column of buttons standing on the bottom of the
iPhone Duo's side strip, on the folded cover screen and the unfolded display. And a settings section
(`app.slots.settingsSection`, "Buttons"), where the owner picks each display's buttons, saved through the
server's RPCs into the plugin's storage. Read the root
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
- **The layout lives in the plugin's key-value store, not in a setting** (`server/layout-store.ts`, key
  `layout`), behind two RPCs (`shared/contract.ts`): `layout.get` (tagged `layout`) and `layout.set`, which
  invalidates the tag, so every open rail and editor on every device reads it again. bb's settings form
  draws every defined setting, and the owner did not want the layout as raw JSON there, so the settings
  are only the two camera gaps (and, for now, the debug switch). `layoutSchema` (zod, no SDK import) is the contract: `layout.set`'s input
  schema refuses a layout the rail could not draw, and `layout.get` answers the default with a `problem`
  for a stored row that no longer parses. The contract is a plain object (`satisfies PluginRpcContract`)
  because the app passes it to `experimental_useRpcQuery` as a value. Adding an action kind means a schema
  entry, `ACTION_CHOICES` / `newLeafAction` / `describeAction` / `suggestedLabel` in
  `app/editor-model.ts`, its fields in `app/editor.tsx`, and how it runs (`app/actions.ts`, or a component
  in `app/rail.tsx` when it needs hooks). Bump `version` in the layout only for a change an older app could
  not read.
- **The old `layout` setting is migrated on the first read** of each load: a valid saved layout moves into
  the store unless the store already has one, and the setting is unset either way
  (`bb.sdk.plugins.updateSettings` with `null`). A setting that is no longer defined keeps its stored value
  in `plugins.getSettings().values` (bb 0.50.1), which is how it is read. A failure is retried on the next
  read; a save never waits on it.
- **A button's name follows its pick until the owner types one** (`withAction`, `hasOwnLabel`): the name
  counts as the owner's when it is neither the kind's default nor what the current pick suggests. A new
  entry opens with its name field focused.
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
- **The command picker's list comes from bb's command-line tool** (`app/command-catalog.ts`), because the
  SDK's plugin list has only each plugin's top-level command: one terminal run of `bb guide commands`
  (bb's own) and `bb <name> --help` for each plugin (its `Commands:` lines). Use the text form of the
  guide: the `--json` form is about 65 KB in one burst, and its start was gone from the terminal's buffer
  before the first read. The listing runs once per page and set of plugins (`command-picker.tsx`); without
  the CLI, the plugins' top-level commands are still offered. Not a `<datalist>`: browsers list only the
  entries matching what is already in the box, so a filled box offered one command.
- **The column stands on the bottom of the strip** (`bottom` = the bottom inset + `BOTTOM_MARGIN`, 8 pt)
  and stacks upward; the camera gap is only its upper limit, and `railPlacement` hides the rail when the
  column would reach above it. The owner chose this after the debug numbers showed that nothing a page
  can read (insets, window, visual viewport, screen) changes when the Dynamic Island grows with a Live
  Activity, so the buttons keep as far from it as they can. Menus open with `align="end"`, level with
  their button's bottom.
- **The camera gaps are settings** (`cameraClearance` folded, default 175; `cameraClearanceUnfolded`,
  default 110; 0–600) because the SDK gives no occlusion rects. `normalizeClearance` keeps a missing or
  broken value usable, falling back to that display's default.
- **The debug numbers are temporary** (`app/debug.tsx`, setting `showDebugNumbers`, default off): a
  readout in the strip just above the rail's top button, positioned out of the column's flow so turning
  it on moves no button (not at the top of the strip: on the device the island and the status icons
  cover it, and only a letter or two showed), of what the page can read (insets from the rail's
  probe, `innerWidth`/`innerHeight`, `visualViewport`, `screen`, `devicePixelRatio`, the gap in use, the
  display), to find out whether any of it follows the Dynamic Island. It reads on resize, orientation,
  `visualViewport` resize and scroll, `visibilitychange`, and every 500 ms, because an inset may change
  with no event. Its lines are at most 15 characters at 8 px and wrap rather than clip. It never takes taps and changes nothing about the rail. To take it out, delete the file,
  its line in `rail.tsx`, `DEBUG_SETTING` and its definition in `server.ts`, and the shot list's debug still.
- **The symbols are bb's own icon names, and only those** (`app/icon-names.ts`). The SDK types a name as
  a string, has no list and no picker, and draws a bolt for a name it does not know, so the list is read
  out of bb's app bundle by `scripts/icon-names.mjs` (`npm run icon-names`; it finds `ICON_NAMES`,
  built there as the eager registry's keys plus a lazily loaded list, by that shape, not by minified
  names). The file names the bb version it came from; rerun it after a bb update. bb 0.49.0 and 0.50.1
  have the same 180 names. `app/icons.test.ts` checks the list has no duplicates and holds every symbol an
  action or a default button starts with; the shot list checks live that every name draws its own glyph,
  not the bolt. The picker (`IconPicker` in `app/editor.tsx`) is a button right of the Name box showing
  the symbol (named "Symbol: <name>"); it opens bb's vendored popover (`components/ui/popover.tsx`, bb's
  bottom sheet on a compact viewport), which closes on a pick, and in it a search box over a scrollable
  radio grid (`SymbolGrid`): New thread first, a saved name outside the list kept right after it (`iconOptions`), cells 36 pt
  and 44 pt on a coarse pointer, and the choice scrolled into the grid's view each time it opens by setting the
  grid's own `scrollTop` (`revealWithin`), never `scrollIntoView`. Playwright's `getByLabel` and role
  names match substrings, so with 180 icon labels in the page a shot list's lookups need `exact: true`
  ("Name" matched `DiffRenamed`, "Pin" `PinOff`). bb's sheet keeps its content mounted after it closes, so `IconPicker` keys
  the grid by an opening counter: each opening starts with an empty search and reveals the choice again
  (the shot list checks it on a phone). The popover is portaled out of the row, so tests and
  the shot list find the grid and its search box from the page, not from the row. The grid scrolls, so it clips whatever its
  cells draw outside themselves: it keeps 4 pt of padding so the chosen cell's ring (1 pt outside the cell)
  shows in the first column too. The popover is 368 pt wide, eight symbols across, capped at the room Radix
  reports (`--radix-popover-content-available-width`, with `collisionPadding` 8) so it stays inside the
  window; the shot list measures all three.
- **Every dropdown is `Select`** (`app/editor.tsx`): a native select with the browser's chevron hidden
  (`appearance-none`) and bb's `ChevronDown` drawn over it, its glyph 13 pt from the right border as the
  text is from the left (bb's 16 pt icon leaves 4 pt around the glyph, so the box sits 9 pt in), and 32 pt
  of right padding so long text stops before it. The owner asked for this; the browser's own chevron sat
  a few points from the border. The shot list measures the drawn glyph, not the icon's box.
- **The app never imports the SDK root at run time** (`app/imports.test.ts`). `shared/` imports only zod.

## Testing without a Duo

Chromium's `Emulation.setSafeAreaInsetsOverride` (a CDP command, reached through Playwright's
`newCDPSession`) sets `env(safe-area-inset-*)` on a page with `viewport-fit=cover`, as bb's is. bb then
pads itself as it does on the device. `shots/shots.mjs` uses it at 466 × 678 (folded, right 84) and
951 × 669 (unfolded, right 85, bottom 21) for the screenshots, and to check placement, the 44 pt targets,
taps reaching the buttons, hiding on a desktop and an ordinary iPhone, no bb control in the unfolded strip,
the drawer covering the rail, the buttons' navigation, and a layout saved in the editor: its Pin button pins
the thread, a command picked from the full list names its button, and its `bb --version` button's result
comes back as a notice. It also checks the settings page shows no layout JSON, and the debug numbers on both displays
(above the top button and under the owner's 235/195 gaps; off for every other still).

The SDK's app harness fakes `useSdk()` (`sdk`), thread actions (`threadActions`,
`threadActionRegistrations`), the plugin's RPCs (`rpc` with `experimental_rpcContract`) and settings, so
`app/rail.test.tsx` and `app/editor.test.tsx` render the real slots over a fake server store. `server.test.ts`
runs the server on the SDK's fake host, migration included.

## Machine

The rail and the editor run in the app; the server defines the camera-gap settings and keeps the layout. A `bb` command runs on the bb server's
machine (`primaryHostId`), where bb installs its command-line tool. There is no `bb.host` entry.
