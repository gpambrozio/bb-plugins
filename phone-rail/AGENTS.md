# AGENTS.md — phone-rail

A sidebar navigation provider (`app.slots.experimental_sidebarNavigation`, placement `rail`): bb's own
Rail, forked, with a separate set and order of destinations for compact (phone-sized) screens. Read the
root `AGENTS.md` first.

## Invariants

- **Wide screens are bb's Rail, unchanged.** Every read and write there goes through
  `experimental_useSidebarNavigation()` and bb's shared preferences (`sidebar.visiblePluginPanels`,
  `sidebar.pluginPanelOrder`). The only addition is **More → Customize phone navigation**.
- **The phone signal is `isCompactViewport`**, the prop bb passes to a navigation component. It is bb's
  own phone test (`(max-width: 767px)`, the one that moves the rail into the drawer), not a device
  signal: the SDK (0.6.104 to 0.6.132) names no client, device or native app. `window.bb.native` exists
  in the iOS app but is bb internals and misses a phone's browser; do not switch to it without a reason.
- **The phone layout is stored per form factor, on the server**: `bb.storage.kv` key `layout.compact`,
  `{ visible, order }` in the same id format as bb's preferences. No key means "follow bb's shared
  preferences". Ids the layout leaves out of `visible` are hidden on phones, so a plugin page installed
  later lands in More there (`shared/layout.ts`, `arrangeItems`).
- **New thread is never hidden**: the header draws it, and `arrangeItems` keeps it visible.
- **Saves are serial and latest-wins** (`app/phone-layout.ts`, `createSerialWriter`): two quick edits
  must not reach the server out of order. While a save is in flight, realtime echoes are ignored and a
  refetch follows the last write. Each window caches the last layout in `localStorage`
  (`phone-rail.layout`) only to avoid drawing bb's full rail before the server answers.
- **A load never overwrites something newer.** Every load is numbered, and an applied announcement or a
  started save bumps a generation; a load's answer counts only if it is the latest load and nothing
  bumped the generation since it began. Otherwise a slow mount or reconnect read puts an old layout
  back on screen and in the cache, and the next edit saves it over the newer one.
- **Phone edits wait for the server** (`isSynced` → `canEditPhone`): until a load or an announcement
  has brought the server's layout, the rail draws the cache or bb's shared set but Hide from rail is
  disabled on a phone and the phone editor shows a loading line, since an edit saves a whole layout
  computed from what is on screen. Opening destinations never waits. A failed first load is retried
  every five seconds.
- **The forked files** (`app/bb-rail/`) note their source commit and every change at the top. When bb's
  Navigation plugin changes, diff `plugins/navigation/app/` between the noted tag and the new one and
  carry the changes over. The vendored UI (`components/ui/`) is from the `@bb` registry at
  desktop-v0.48.1; `sidebar-visibility-customize` is bb's own customize list.
- **The app imports the RPC contract as a type only** (`app/imports.test.ts`).

## Machine

Everything runs in the app and in the bb server's process; there is no `bb.host` entry.
