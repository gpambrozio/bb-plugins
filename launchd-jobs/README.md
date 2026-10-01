# Scheduled Jobs (launchd-jobs)

Shell commands on your Mac on a cron schedule or a fixed interval, run by launchd — so they run whether
or not bb is open. Ported from
[`paseo-plugins/launchd-jobs`](https://github.com/gpambrozio/paseo-plugins/tree/main/launchd-jobs), and
it picks up the jobs that plugin made, history and all.

The **Scheduled jobs** page lists your jobs with what launchd knows about each one — loaded, running,
disabled, or how its last run ended. Open a job for its schedule, its command, its last twenty runs
with how long each took and how it exited, and the tail of its log.

- **New job**: a name, a command, an optional working directory, and either a five-field cron
  expression or a fixed interval. The form says the schedule in words as you type — "At 09:00 on
  Mon–Fri".
- **Run now**, **Enable** / **Disable**, **Edit** and **Delete**, each doing the launchd part for you.
- **Follow** shows the log as the job writes it. Press it again to stop; it also stops when you leave
  the job.
- When a job's most recent run failed, the sidebar row says **N failing**. Opening the job clears it
  from the count, until it fails again.
- With more than one Mac connected to bb, a picker at the top chooses whose jobs you see. It starts on
  the Mac running the bb server.

It is a front for launchd, not a scheduler of its own: the plists in `~/Library/LaunchAgents` are the
source of truth, and the page reads them back every time.

## What you need

- bb 0.44 or later.
- macOS, on the Mac whose jobs you manage. On any other machine the page says the plugin is macOS only.

## Install

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@^0.1.0' --plugin launchd-jobs --tag-prefix launchd-jobs/
```

The page is **Scheduled jobs** in the sidebar; the palette has *Scheduled jobs: open launchd jobs*.

## What a job is

Each job is one file, `~/Library/LaunchAgents/com.paseo-plugins.launchd-jobs.<name>.plist`. The plugin
only lists, writes and removes files whose label starts with that prefix, so your other LaunchAgents are
never touched. A plist you write by hand under the prefix shows up too. A file under the prefix that is
a link, or that names some other job inside, is left alone: the first is not shown, the second is shown
with what is wrong and cannot be changed from here.

The command runs through `/bin/zsh -lc`, so it can be anything you would type at a prompt, with the
PATH your interactive shell reports. launchd's own PATH is `/usr/bin:/bin:/usr/sbin:/sbin` with nothing
from Homebrew or a version manager, which is the usual reason a job works in the terminal and fails when
scheduled. The PATH is captured when the job is saved; if you change it, save the job again.

The working directory is optional and may start with `~/`. Without one, launchd starts the command in
your home directory.

### Schedules

**Cron expression**, five fields: minute, hour, day of month, month, weekday. Lists (`1,15`), ranges
(`9-17`), steps (`*/15`, `9-17/2`) and three-letter names (`mon`, `jan`) all work. launchd has no
expression language, so every combination of the values you list becomes its own launchd entry, and the
form shows how many: `0,30 9-17 * * 1-5` is ninety. The cap is a thousand.

One difference from cron: when both a day of month and a weekday are given, cron fires when *either*
matches, launchd only when *both* do. The preview says "(both must match)".

**Fixed interval**: every N seconds, minutes or hours, counted from when the job was loaded.

### When it fires, and when it does not

- **bb closed**: the job runs. launchd does not know bb exists.
- **Mac asleep at the scheduled time**: launchd runs the job once when the Mac wakes. Several missed
  times collapse into one run.
- **Mac off, or you logged out**: the run is missed. LaunchAgents belong to your login session.
- **Job disabled**: launchd remembers that across reboots until you enable it again.
- **bb quits while you are saving a job**: the job may be left **Not loaded**, and the page says so.
  Press **Enable**, or save it again, to load it. A job that is already running is never affected.

## Runs and logs

Every run appends to the job's log — a start line, the command's output, and an exit line — and one
record to its history. The page shows the last twenty runs and the last 64 KB of the log. A log is
rotated once it passes 1 MB, and the history keeps its last two hundred runs.

Jobs made here keep those files in bb's data folder for this plugin
(`~/.bb/plugins/launchd-jobs/host-data/` on the Mac running the bb server).

## Coming from the Paseo plugin

Your Paseo jobs appear on the page as they are: same names, same schedules, their run history and logs.
Nothing is moved or copied; their files stay in `~/.paseo/plugin-data/launchd-jobs/`, and the plugin
reads them there. Editing one keeps its log and history there too, so the Paseo plugin — if you still
have it — goes on showing the same job. A job made here shows in the Paseo plugin as one it did not
write.

Opening a failing job here clears it from this plugin's count; a failure you had already cleared in
Paseo stays cleared.

## Removing

Deleting a job unloads it, deletes the plist, and deletes its log and history. Removing the *plugin*
does not: the jobs stay installed and keep running, because they are launchd's. Delete them first, or
delete the plists by hand and run `launchctl bootout gui/$UID/<label>` for each.

## Limitations

- macOS only.
- The failing count only knows about runs that finished badly. A job launchd has quietly stopped
  scheduling — shown as **Not loaded** — is not counted, because finding that out means asking launchd
  about every job once a minute.
- The count covers the Mac running the bb server, and any other Mac once you have opened its jobs here
  and it has some. It is checked about once a minute, so it can be a minute behind.
- What launchd reports — whether a job is running, its process id, its spawn count — comes from
  `launchctl print`, whose output is prose. If a macOS release rewords it, those facts go blank until the
  plugin is updated; the run history and the log do not depend on it.
