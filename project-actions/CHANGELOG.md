# Changelog

Notable changes to `project-actions`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.1

### Fixed

- **Actions now run with your full terminal setup.** Your shell's startup files, such as `~/.zshrc` or
  `~/.bashrc`, load before the command, exactly as in a terminal you open yourself, so the programs,
  environment variables, aliases and functions they set up are there. Before, only the login files
  loaded, and a command that relied on something from `~/.zshrc` was not found.
- **An action always starts in its own folder**, even when your shell's startup files change folder.

## 0.1.0

### Added

- **A menu of your project's actions in every thread's header**: named commands such as starting the
  dev server or running the tests, listed in a `.bb/actions.json` file committed in the project.
- **Each action runs in a terminal of that thread**, in the thread's own worktree (or a folder inside
  it), titled with the action's name and opened in bb's terminal panel. Threads on other bb machines run
  their actions there.
- **Actions stay inside the project**: an action's folder must be in the project, and one that leads
  outside it, through a link for instance, is refused when the action starts.
- **No duplicates**: picking an action that is still running shows its terminal again. A finished one
  keeps its output and how it ended until you run it again.
- **Clear help when the file is missing or wrong**: the menu explains how to add the file, or shows the
  mistake with its line and column.
- **An editor for the actions**, from the menu: add, change, reorder and delete actions in a form, or edit
  the file as JSON. A command can span several lines. It checks every change as the menu does, will not save a file with a mistake, saves
  into the thread's own workspace (creating the file when there is none) without committing it, and will
  not overwrite a file that changed on disk since it was opened.
