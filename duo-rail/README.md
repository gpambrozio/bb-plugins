# Duo Rail (duo-rail)

Put bb's controls, your choice of them, in the empty strip below the camera on both of the iPhone Duo's
displays.

The iPhone Duo keeps a strip down one side of each display for the camera, the clock and the status
icons: 84 points wide on the folded cover screen, about 85 on the unfolded display. Those take the
strip's top; the rest is blank, and bb leaves it blank. Duo Rail puts a column of symbol-only buttons
there, the way Apple places a Duo app's own controls: primary navigation first.

Out of the box, both displays get the same three:

- **Back** returns to the screen you were on before.
- **New thread** opens the new thread screen.
- **More** opens your five most recent threads (a dot marks one that is waiting for you or has an unread
  reply), **Forward**, and **Reload bb**. On the cover screen it is a sheet; unfolded, a menu beside the
  button.

You can change all of it, separately for each display, in **Buttons** on the plugin's settings page:
which buttons, in what order, each one's symbol, and what it does (see *Buttons* below).

Everywhere else (a desktop, an ordinary iPhone, an iPad, Split View) it draws nothing.

## Screenshots

On the folded cover screen (466 × 678 points) and the unfolded display (951 × 669 points), with the
insets the Duo reports simulated in a browser:

| Folded | Folded, More | Unfolded | Unfolded, More |
| --- | --- | --- | --- |
| ![The rail on the right of the cover screen](docs/screenshots/cover-light.png) | ![The More sheet](docs/screenshots/cover-more-light.png) | ![The rail beside bb's wide layout](docs/screenshots/unfolded-light.png) | ![More's menu beside the rail](docs/screenshots/unfolded-more-light.png) |
| ![The rail in dark mode](docs/screenshots/cover-dark.png) | ![The More sheet in dark mode](docs/screenshots/cover-more-dark.png) | ![The unfolded rail in dark mode](docs/screenshots/unfolded-dark.png) | ![More's menu in dark mode](docs/screenshots/unfolded-more-dark.png) |

| The Buttons editor | Picking a command | Your own buttons |
| --- | --- | --- |
| ![Editing the folded buttons](docs/screenshots/editor-light.png) | ![Every plugin's commands and bb's own, in a list that narrows as you type](docs/screenshots/editor-commands-light.png) | ![Pin and two bb commands added to the folded rail, with a command's result](docs/screenshots/cover-custom-light.png) |

Dark editor: [screenshot](docs/screenshots/editor-dark.png). On a mirrored device the rail is on the left:
[screenshot](docs/screenshots/cover-mirrored-dark.png). With bb's sidebar drawer open, the rail steps
aside: [screenshot](docs/screenshots/cover-drawer-open.png).

![New thread, Back, a recent thread from More, and the rail stepping aside for bb's sidebar](docs/screenshots/duo-rail-demo.gif)

![Unfolded: More's recent threads, then Back](docs/screenshots/duo-rail-unfolded.gif)

## What you need

bb 0.49 or later, and an iPhone Duo with bb's iOS app. No account, service or API key. A button that
runs a `bb` command also needs bb's command-line tool on the bb server's machine (bb's Settings → General
→ Command line).

## Install

From the pull request's branch, to try it before it is released:

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@fm/duo-rail-plugin' --plugin duo-rail
```

Once released:

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@^0.1.0' --plugin duo-rail --tag-prefix duo-rail/
```

From a clone:

```bash
cd duo-rail
npm ci && bb plugin build
bb plugin install "path:$PWD" --yes
```

## Buttons

Settings → Plugins → Duo Rail → **Buttons**. Pick **Folded** or **Unfolded**, then add, remove and reorder
buttons. A new button opens ready to edit; give it a symbol and an action, and a name if you like (read
out by VoiceOver). Until you type a name of your own, a button is named after what you pick: the thread,
the project, the thread-menu action or the command. **Save** stores the layout in Duo Rail's own storage
on the bb server, so every device you use bb on follows it. **Copy the … buttons** copies the other
display's list; **Back to the default buttons** restores Back, New thread and More.

A button can:

| Action | What it does |
| --- | --- |
| Go back, Go forward | The page's history, as the browser's buttons would. |
| New thread | bb's New thread screen, in a project you pick or bb's own choice. |
| Recent threads | A menu of your most recent threads (1 to 10). |
| Open a thread | One thread you pick. |
| Open a project | One project you pick. |
| Thread menu action | An action from bb's thread menu, bb's own (Pin, Mark as read, Archive, Copy link, …) or another plugin's, on the thread you are looking at. Greyed out where no thread is open. An action with choices opens them as a menu. |
| Run a bb command | `bb <words…>` on the bb server's machine. The editor lists every command there is, each installed plugin's commands and subcommands and bb's own, and narrows the list as you type; add arguments after the one you pick. Its last lines come back as a notice. It is stopped after a minute. |
| Open a URL | A web address opens in bb's browser, as your bb settings say; an app link asks first. |
| Reload bb | Reloads the page. |
| Menu | A menu of its own items, each any of the above. More is one. |

**Export** copies both displays' buttons to the clipboard as text; **Import…** takes such a text from
another bb (Save keeps it). The server refuses a layout the rail could not draw, and says why.

Up to eight buttons fit on a display. When the column would not fit between the camera gap and the bottom
of the screen (with the keyboard up, for one), the rail hides rather than draw a cut-off button.

### Not offered

bb's SDK gives a plugin no way to reach these from the rail, so the editor does not offer them:

- **Search** and **opening the sidebar**;
- **bb's own pages** (Home, Automations, Settings, …) and other plugins' pages;
- **bb's command palette** and its commands, and keyboard shortcuts.

The rail would have to press bb's own buttons or send bb's shortcuts, and both break when bb changes. Until
bb adds those routes, bb's sidebar button stays in its corner and **More** lists recent threads.

## Space for the camera

Two settings, one per display, in the same place: **Space for the camera, folded** (default 175 points)
and **unfolded** (default 110). Each is how far below the top of the screen the first button sits. bb cannot
tell a plugin where the camera and the clock end, so these are measured guesses. Raise one if the first
button sits under the clock; lower it to move the buttons up.

## Debug numbers

For now, the rail also shows small text under its last button: which display it
thinks it is on, the camera gap in use, the four safe-area insets the page reads, the window's size, the
visual viewport's size and offset, the screen's size and its pixel ratio. They update live, on every
resize, rotation, scroll of the visual viewport and return to bb, and twice a second besides, because an
inset can change without any event. They are there to learn whether anything the page can read changes
with what the Dynamic Island shows, a Live Activity or only the clock. Turn off **Show debug numbers**
on the plugin's settings page to hide them.

| Folded | Unfolded |
| --- | --- |
| ![Debug numbers under the folded rail's last button](docs/screenshots/cover-debug-light.png) | ![Debug numbers under the unfolded rail's last button](docs/screenshots/unfolded-debug-light.png) |

## When it shows

The rail shows when the page has a safe-area inset of at least 44 points on exactly one side, none on the
other, and no top inset, whatever layout bb chose. That is the Duo's signature on both displays: right 84
(or about 85 unfolded), top 0 (left on a mirrored device). An ordinary iPhone has a top inset in portrait
and an inset on both sides in landscape; a desktop, an iPad and Split View have no side strip. bb's compact
(phone) layout, which the cover screen gets, means the folded buttons; bb's wide layout, which the unfolded
display gets, means the unfolded ones. The rail reads the insets the way bb's own layout does, from CSS
`env(safe-area-inset-*)`.

It also stays out of bb's way. bb keeps its page out of the strip on both layouts, so the rail covers none
of bb's interface and moves none of it, and only its buttons take taps. bb's drawers, sheets, dialogs,
menus and toasts all sit above it. When one of them covers a button, as bb's sidebar drawer does when it
slides the page sideways, the rail fades out until it is gone.

## Only a real Duo can confirm

Everything above was tested in a browser at each display's size, with the Duo's insets set through
Chromium's safe-area override. bb's page pads itself exactly as on the device there. These need the real
device:

- that taps in the strip below the camera reach the page in bb's iOS app, rather than being kept by the
  system, on both displays;
- that 175 points clears the camera and the vertical clock folded (from a measurement in the iOS 27.1
  simulator, where the status column is 174 points tall), and 110 the clock and status icons unfolded
  (read off a screenshot of the unfolded display);
- that the unfolded display reports its strip as a right inset of about 85 and no top inset, as the
  screenshot suggests, and that bb picks its wide layout there;
- that the strip is on the side the insets say it is on a mirrored device.

## Develop

```bash
npm install --include=dev
npm run typecheck
npm test
bb plugin build
```

Screenshots come from `tools/shots` (`npm run shots -- duo-rail`), which also checks the rail's
placement, taps and hiding on both displays, the editor, and a saved layout's buttons in a dev bb. See
`AGENTS.md` for the plugin's invariants.
