# Changelog

Notable changes to `launchd-jobs`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.1

### Changed

- Built and tested against bb 0.45. Nothing you can see changes, and it still runs on bb 0.44.

## 0.1.0

The first release: Scheduled Jobs for bb, ported from the Paseo plugin `launchd-jobs` (0.5.0).

### Added

- **A Scheduled jobs page** in the sidebar. Create a job with a name, a command, an optional working
  directory and a schedule, and it becomes a LaunchAgent on your Mac. launchd runs it from then on,
  whether or not bb is open, and runs a missed one when the Mac wakes.
- **Two ways to say when**: a five-field cron expression, shown in words as you type it, or a fixed
  interval in seconds, minutes or hours.
- **What each job did**: whether it is running, disabled or failed, its last twenty runs with how long
  each took and how it ended, and the tail of its log.
- **Run now, Enable, Disable, Edit and Delete**, each doing the launchd part for you.
- **Commands find your tools**: each job runs with the same PATH as your terminal, captured when it is
  saved.
- **Follow** a job's log to see output as the job writes it. Unlike in Paseo, following no longer
  borrows one of your workspaces or shows up in its terminal list.
- **The sidebar says how many jobs are failing**, beside the Scheduled jobs row. Opening a job clears
  it from the count until it fails again.
- **Every Mac connected to bb**: with more than one, a picker chooses whose jobs the page shows.
- **Only your jobs are touched.** A file under the jobs' name that is a link, or that names some other
  job inside, is left alone, and a job whose files are in a folder this plugin does not know is shown
  but its files are never changed.
- **A job bb could not finish saving says so.** If bb quits while you save a job, the job may be left
  not loaded; the page shows it as Not loaded, and Enable, or saving it again, loads it.

### Changed from the Paseo plugin

- **Your Paseo jobs come along as they are.** They show up with their names, schedules, run history
  and logs, which stay where Paseo keeps them; nothing is moved. Editing one here keeps its history
  there, so the Paseo plugin keeps showing it if you still have it installed. A failure you already
  cleared in Paseo is not counted again.
