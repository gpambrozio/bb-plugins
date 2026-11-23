# AGENTS.md — duo-rail

One app overlay (`app.slots.experimental_appOverlay`): a column of buttons in the folded iPhone Duo's
side strip, below the camera. Read the root `AGENTS.md` first. Background: get-bb/bb#7507 (the strip,
its measurements, and Apple's guidance) and the scout report that proposed this plugin.

## Invariants

- **The show rule is `shared/placement.ts` and nothing else**: compact layout, no top inset, an inset of
  at least 44 pt on exactly one side. It is pure and table-tested; change it there, with a row for the
  device you are adding or excluding. The SDK names no device, so the rule keys on insets, which is
  also how Apple says to tell layouts apart.
- **Insets come from CSS `env(safe-area-inset-*)`**, read through an invisible probe element
  (`app/insets.ts`), as bb's own layout reads them. bb's native bridge also carries insets, but it is bb
  internals. Compact is bb's own media query, `(max-width: 767px)`, through the vendored
  `useIsCompactViewport`. An overlay is not passed `isCompactViewport`.
- **The rail never covers or moves bb's interface.** bb pads its page out of the strip, so the rail draws
  only inside the strip's width (`width` = the inset). The column is `pointer-events: none` and only the
  buttons take taps. A menu trigger passes its own `className`; `RailButton` merges it, otherwise
  `pointer-events-auto` is lost and taps on More fall through (a regression test covers it).
- **Stacking: z-index 39.** bb's compact page is z 30, and every layer bb draws over it is 40 or higher:
  the sidebar drawer's transparent tap-to-close layer 40, the full-page tool panel 45, toasts 49, and
  dialogs, sheets and menus 50. bb's compact drawer slides the page sideways rather than covering it, so
  the rail also fades out while anything covers a button (`app/covered.ts`). That is a hit test
  (`elementFromPoint` at each button's centre, re-run on DOM mutations, resizes and transition ends) that
  names no bb element. The faded rail keeps its hit area, so the test sees when it is uncovered.
- **Only SDK routes and web-platform calls.** New thread is `useBbNavigate().toCompose()`, the recent
  threads are `experimental_useSidebarThreads` → `toThread`, and Back, Forward and Reload are
  `history.back()`, `history.forward()` and `location.reload()`. bb's thread search and sidebar drawer
  have no SDK route from an overlay: `experimental_useSidebarNavigation()` is empty outside the sidebar,
  and the drawer's state is internal. Do not add them by clicking bb's buttons or sending its keyboard
  shortcuts.
- **The camera clearance is a setting** (`cameraClearance`, default 175, 0–600) because the SDK gives no
  occlusion rects. `normalizeClearance` keeps a missing or broken value usable.
- **The app never imports the SDK root at run time** (`app/imports.test.ts`).

## Testing without a Duo

Chromium's `Emulation.setSafeAreaInsetsOverride` (a CDP command, reached through Playwright's
`newCDPSession`) sets `env(safe-area-inset-*)` on a page with `viewport-fit=cover`, as bb's is. bb then
pads itself as it does on the device. `shots/shots.mjs` uses it at 466 × 678 for the screenshots, and to
check placement, the 44 pt targets, taps reaching the buttons, hiding on a desktop and an ordinary
iPhone, the drawer covering the rail, and the buttons' navigation.

## Machine

Everything runs in the app; the server only defines the setting. There is no `bb.host` entry.
