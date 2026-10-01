# AGENTS.md

A bb plugin that adds a **Scheduled jobs** sidebar page: shell commands on a cron expression or a
fixed interval, written as LaunchAgents and run by launchd on a Mac, whether or not bb is open. It is
the port of the Paseo plugin `launchd-jobs` and **adopts that plugin's jobs** where they are.

The repository root `AGENTS.md` covers what every plugin here shares. This file covers only what is
specific to `launchd-jobs`.

## Orientation

| File | What it owns |
| --- | --- |
| `host.ts` | The host entry: binds `shared/host-contract.ts` to `host/jobs.ts` and `host/follow.ts`. |
| `host/jobs.ts` | Every `launchctl` and `plutil` call, the plist writer, the runner, logs, history, names, acknowledgements. |
| `host/follow.ts` | Follow mode: a native watch on a job's log directory, with an expiry. |
| `host/run-command.ts` | Every external command: bounded by a timeout and a cancellation signal, with SIGKILL escalation. |
| `server.ts` | Forwards each app call to the chosen Mac's host entry; relays log changes; runs the health poll. |
| `server/health.ts` | The failing count: which Macs are asked, and when it is published. |
| `shared/cron.ts` | cron ⇄ `StartCalendarInterval`, and the sentences. In the app and host bundles. |
| `shared/jobs.ts`, `shared/channels.ts` | Zod shapes and realtime channels; no SDK import, so the app may use them at run time. |
| `shared/contract.ts`, `shared/host-contract.ts` | The app ⇄ server and server ⇄ host contracts. The app imports them as types only. |
| `app/jobs-panel.tsx` | The page: Mac picker, list, and the detail or form pane. An answer that arrives after the user switched Macs is dropped, and a pane never outlives the Mac it was opened on: the same slug on another Mac is another job. |
| `app/job-detail.tsx`, `app/job-form.tsx`, `app/log.ts` | The detail pane, the form, and the log with Follow. |
| `app/health.tsx` | The failing count as the app sees it, and the sidebar row's accessory. |
| `host/fake-launchd.ts` | Test support: an in-memory launchd behind the same `RunCommand`. |

`npm test` runs everything; the tests that write or parse plists, or run the runner, need macOS.

## Decisions

**Why this plugin exists beside bb's `automations`.** `automations` runs scheduled scripts from the
bb server, so only while bb runs. A LaunchAgent runs while bb is closed, runs a missed fire when the
Mac wakes, keeps a disable across reboots, and is a plist the user can read and edit. And the owner's
jobs already exist as LaunchAgents made by the Paseo plugin; this plugin shows and manages them.

**Which machine: a `bb.host` entry.** `launchctl` must run on the Mac that owns the jobs, as that
user, in that user's login session, so all of `host/jobs.ts` runs in the host entry, never in the bb
server's process. The server only forwards (`bb.hosts.experimental_client(...).call(method, input,
{ hostId })`). The page opens on `bb.sdk.system.config().primaryHostId` — the Mac running the bb
server — and offers a picker when more than one host is connected; off macOS the host answers
`supported: false` and the page says so.

**The label prefix stays `com.paseo-plugins.launchd-jobs.`** That is what adopts the existing jobs.
Changing it would silently orphan every job a user already has; there is no migration and none is
planned.

## The label prefix is the ownership boundary

`listSlugs` globs `com.paseo-plugins.launchd-jobs.*.plist` in `~/Library/LaunchAgents` and nothing
else there is ever read, written or booted out. Every handler that takes an id first checks that it
is one of those slugs (`assertKnown`), which also keeps an id from naming a path anywhere else.

- **Only regular files count.** A symlink under the prefix is not listed, so nothing writes through it
  to whatever it points at.
- **The plist's `Label` must be the one its file name gives.** `bootstrap` loads the label *inside*
  the file, so a prefixed file naming another label is listed with that as its problem, and every
  change — update, enable, disable, run, delete — is refused (`assertOwned`). Every change that
  loads, rewrites or runs a job needs a plist that *parsed* with the matching label: an unreadable
  plist, even one that fails to convert only this once, can only be deleted, because deleting boots
  out this slug's own label and removes the file without trusting what it says.
- **Plists are replaced whole**: written to a temporary name in the same directory, then renamed over
  the old one. A new job's plist is *linked* into place, which fails instead of replacing when that
  slug was taken meanwhile (by the Paseo plugin, say); the next slug is tried.

## One change at a time

Every handler that changes something on a Mac — create, update, delete, enable/disable, run,
acknowledge — runs inside `exclusive`, one after another. Choosing a slug and writing its plist, a
read-modify-write of `jobs.json` or `acknowledged.json`, and a bootout/rewrite/bootstrap never
interleave with another change. Reads (`list`, `log`, `health`) do not wait. The JSON files are also
written atomically, so a reader never sees half a file. This is per host worker; the Paseo plugin,
running elsewhere, is guarded only by the exclusive link above.

The lock's hold is bounded. Each handler passes its call's `context.signal`: a change cancelled while
it waits (the RPC timed out, the worker is stopping) is skipped, not run late, and one cancelled
while running has its current command stopped — the signal reaches every command through an
`AsyncLocalStorage`, so reads running beside it are unaffected. Commands run through
`createRunCommand` (`host/run-command.ts`): on timeout or abort the child gets SIGTERM, then SIGKILL
after `KILL_GRACE_MS`, and after another grace the promise rejects even if a grandchild still holds
its output open. `execFile`'s own `timeout` only sends SIGTERM, which a child may ignore forever.

## Adopting the Paseo plugin's jobs

Each plist names its own data directory in `EnvironmentVariables.PASEO_LAUNCHD_JOBS_DIR`, and its
runner by absolute path. `dataDirOf` reads that, and a job's log, history and runner are looked for
**there** — the Paseo plugin's `~/.paseo/plugin-data/launchd-jobs/` for its jobs, this plugin's own
host data directory (`context.experimental_paths.dataDir`, `~/.bb/plugins/launchd-jobs/host-data/` on
the server's Mac) for jobs made here. One reader serves both because the runner format is the same:
keep the log markers and the history line identical to the Paseo runner's.

- **On load, nothing is moved, rewritten or deleted** — not the Paseo directory, not its plists.
  Listing, reading logs, counting failures and following are read-only on it; the tests prove it with
  a snapshot of every file and mtime.
- **Names**: this plugin's `jobs.json` first, then the `jobs.json` in the job's own directory. A
  rename here lands in this plugin's file only.
- **Acknowledgements**: this plugin's `acknowledged.json`, then the one in the job's directory for a
  slug this plugin has no word on, so a failure already seen in Paseo does not light the count up.
- **`managed`** means the plist is the four-element runner shape whose runner is
  `<the directory the plist names>/runner.sh`. A job made by either plugin is managed here; a job made
  here shows as unmanaged in the Paseo plugin, whose check is against its own runner path.
- **Editing an adopted job keeps its paths** (only for a trusted Paseo directory). The plist is rewritten with the same runner, data
  directory and stderr path, so its history continues where it is and the Paseo plugin, if still
  installed, sees a job it still manages. This plugin never writes a runner into a directory it does
  not own. Only if that directory has lost its `runner.sh` does the job move to this plugin's own
  directory (its earlier history stays behind).
- **Trusted directories.** This plugin writes or deletes in exactly two kinds of data directory: its
  own, and the Paseo plugin's (`$PASEO_HOME/plugin-data/launchd-jobs/` and the older
  `$PASEO_HOME/plugins/launchd-jobs/`, `PASEO_HOME` defaulting to `~/.paseo`). `homeOf` compares real
  paths, so a symlink to a trusted directory is trusted and a look-alike path is not. Any other
  directory a plist names is **read-only**: its log and history are shown (`readOnlyData`), deleting
  the job removes only the plist, and saving an edit moves the job to this plugin's own directory.
  `managed` (the runner shape) grants nothing; a hand-written plist can copy it.
- **Deleting an adopted job** removes its plist and its own log and history files from the Paseo
  directory, as deleting did in Paseo — unless that directory's `logs/` or `runs/` is a link out of
  it, in which case those files are left alone. Nothing else there is touched; its stale `jobs.json`
  entry is harmless.
- The Paseo plugin's own migration out of its older `plugins/launchd-jobs/` directory
  (`data-dir.ts`, `moveLegacyFiles`, the forwarder) is not ported. A plist still pointing there simply
  shows that directory's files; the Paseo plugin finishes its own move.

## The launchctl choreography

Modern `launchctl` (`bootstrap`/`bootout`/`kickstart`/`enable`/`disable`) against `gui/<uid>`, never
`load`/`unload`. The host worker runs as the user inside the login session, so `process.getuid()`
supplies the uid.

- **Update is bootout, rewrite, bootstrap.** launchd does not reread a changed plist, and
  bootstrapping a loaded label fails. The login PATH is probed (up to two `zsh` runs) *before* the
  bootout, so the job is out of launchd only for the rewrite. `bootoutIfLoaded` swallows only the two "not loaded" spellings
  (`No such process`, `Could not find service`); anything else is thrown. A disabled job is not
  bootstrapped after an update.
- **Enable is `enable` *then* bootstrap**; bootstrapping a disabled label is refused. Disable is
  bootout then `disable`, so the job stops now and stays stopped after a reboot.
- **Delete runs `enable` before removing the plist.** `disable` is stored per label in launchd's
  override database, not in the plist; without this a later job with the same slug is born disabled.
  If `enable` fails, the delete fails and the plist stays (unloaded), so deleting again retries.
  The override entry itself (`"<label>" => enabled`) stays in `print-disabled`; launchctl has no way
  to remove it.
- **A failed create leaves the plist in place.** The list shows it "Not loaded" with the error in a
  toast, and Enable retries.
- **Run now is `kickstart`**, refused when the label is not loaded.

`statusOf` parses `launchctl print` prose: `state = `, `pid = `, `runs = `, `last exit code = `
(the first `state = ` line; nested `state = active` lines follow it). Exit 113 with "Could not find
service" means not loaded; everything else is thrown. Do not add fields from that output.

## The runner

launchd spawns `/bin/zsh <data>/runner.sh <slug> <command>`. The runner brackets the command's output
in the log with start and exit markers, appends one JSON line of history, rotates the log past 1 MB
and keeps the last 200 history lines. It is `RUNNER_SCRIPT` in `host/jobs.ts`, written into this
plugin's own directory on every save when it differs (temporary file, `chmod`, rename — launchd may
start it at any moment). A change reaches a job the next time any job is saved; if the format changes
incompatibly, the Paseo-written history stops reading the same, so don't.

**There is no `StandardOutPath`.** launchd opens that file at spawn and keeps it across the run, so a
rotated log would go on receiving output. The runner appends itself, which makes rotation a plain
`mv`. `StandardErrorPath` points at the same log only so a failure of the runner itself lands
somewhere.

The command runs through `/bin/zsh -lc` **and** the plist carries a `PATH` captured by
`loginShellPath`: `zsh -lic` first (most people export PATH in `.zshrc`), then `zsh -lc`, then the
host worker's own PATH, with a five-second timeout because an interactive shell without a TTY can
hang.

## cron ⇄ calendar entries

`toCalendarEntries` is the cartesian product of every restricted field. `MAX_ENTRIES` (1000) is
enforced in `parseCron`, so the form refuses it before the host does. Weekday `7` folds to `0`.
`describeCron` appends "(both must match)" when day and weekday are both restricted: cron ORs them,
launchd ANDs them. `fromCalendarEntries` only accepts entries that are exactly such a product — compared as
sets, so a duplicated entry cannot stand in for a missing one, and the size of the implied product is
checked against the number of distinct entries *before* the product is built, so a few entries
spanning every field cannot make it expand into millions — which is also what a hand-written plist
usually is; anything else lists as a raw calendar. A calendar value launchd cannot use (`Minute 99`)
makes that row's `problem`; every row is checked against `JobSchema` before it is answered, so one
bad plist never fails the whole list.

## Follow

The Paseo plugin borrowed a workspace terminal to run `tail -f`; that hack is gone. `follow` starts a
native watch (`context.experimental_watch`) on the job's `logs/` directory in the host worker, and
each change to the log, or to its rotation, emits the `logChanged` host signal; the server relays it
as `log-changed` over realtime; the app reads only what was appended (`log` with `from`).

- A log read is cut at newlines: `text` is whole lines, `pending` the line in progress, `next` the
  offset after the last newline. A shorter file, or more than 64 KB since `from`, answers `reset`.
- A follow expires `FOLLOW_TTL_MS` after the last `follow` call; the app renews it every 15 s and
  calls `unfollow` when it stops or unmounts. A window that vanishes leaves nothing behind for long.
  An active watch keeps the host worker alive, which is what an expiry protects.
- Realtime is broadcast and not persisted, so the app also polls for appended bytes every 5 s while
  following. That poll also covers the one shared-watch gap: a follow is per job, not per window, so
  one window's Stop ends the watch for another window following the same job until its next renewal.
- A renewal naming a different log path (an edit moved the job's files) restarts the watch there.
- The watch on an adopted job's directory only observes. The host creates `logs/` only inside its own
  directory.

## The failing count

`app.slots.navPanel`'s `experimental_sidebarAccessory` renders "N failing" beside the static row —
no re-registering, unlike Paseo. The server owns the count (`server/health.ts`), re-taken every 60 s
by a background service whether or not any window is open, and published on `health-changed` only
when it changes; the app reads it on mount and after a reconnect.

- `health` on the host touches no `launchctl`: the plists (parsed once per mtime) and the last line
  of each history file. A job launchd quietly stopped scheduling is therefore not counted; the
  page's status column is where that shows.
- The server's own Mac is always asked. Another Mac is asked only once a listing there found a job
  (kv `watched-hosts`), and drops out when it has none, so a laptop nobody looked at is not woken
  every minute. A Mac that is asleep keeps what it last reported; a Mac removed from bb is forgotten
  with its failures, since nobody could open it to clear them.
- A recount asked for while a check is running (after an acknowledge or a delete) waits for it and
  runs once more, because the running check may have read the files before the change.
- The poll keeps the server Mac's host worker alive (60 s is inside the 5-minute idle stop).
- **Acknowledgement is per run.** Opening a failing job's detail acknowledges its latest run; the
  next failure alerts again. A job whose latest run succeeded loses its entry. Entries for jobs that
  no longer exist are pruned on every write; delete drops its own.

## Checking against reality

There is no scratch launchd. The host tests use `host/fake-launchd.ts` and temporary directories, and
never touch `~/Library/LaunchAgents`. A live check of create/run/delete goes into the real launchd:
name the job `fm-smoke-…` so it is obviously one, and delete it from the page or with
`bb plugin rpc call launchd-jobs delete`. Reading — `list`, `log`, `health` — is safe on real jobs:

```bash
echo '{}' > /tmp/empty.json
bb plugin rpc call launchd-jobs hosts --input-file /tmp/empty.json     # the primary host id
echo '{"hostId":"host_…"}' > /tmp/in.json
bb plugin rpc call launchd-jobs list --input-file /tmp/in.json
```

`bb plugin rpc call` sends `null` without `--input-file`, which every method here refuses.
