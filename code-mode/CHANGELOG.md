# Changelog

Notable changes to `code-mode`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

### Added

- **Send in Code Mode**, in the menu beside the Send button of a new thread: the thread starts in Claude
  Code's experimental Code Mode, and keeps it for good. No environment variable to set and no bb restart.
- **Projects that start in Code Mode**, on the plugin's settings page: a new Claude Code thread starts
  in Code Mode without the menu when its project is on there and its machine is on. Projects are listed
  once per name, and projects with the same name, including ones you add later, share the switch.
- **A setting for threads that agents and plugins start**: follow the project, never, or the same as the
  thread that started them. Forks keep the choice of the thread they came from.
- **Machines that may run Code Mode**, all off until you turn them on, each showing whether it is ready.
- **Select all and Select none** for both lists. Select all on machines turns on only the machines
  that are ready, and shows why the others stay off.
- **A Code badge** on a Code Mode thread's row, and a **Code Mode: on** line in its thread menu.
- **A model guard**: a message that would move a Code Mode thread to a model that can't run Code Mode is
  refused, with the reason, instead of leaving the thread unable to resume.
