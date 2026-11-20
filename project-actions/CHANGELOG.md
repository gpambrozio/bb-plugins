# Changelog

Notable changes to `project-actions`. The other plugins in this repository version separately.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version numbers
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

### Added

- **A menu of your project's actions in every thread's header**: named commands such as starting the
  dev server or running the tests, listed in a `.bb/actions.json` file committed in the project.
- **Each action runs in a terminal of that thread**, in the thread's own worktree (or a folder inside
  it), titled with the action's name and opened in bb's terminal panel. Threads on other bb machines run
  their actions there.
- **No duplicates**: picking an action that is still running shows its terminal again. A finished one
  keeps its output and how it ended until you run it again.
- **Clear help when the file is missing or wrong**: the menu explains how to add the file, or shows the
  mistake with its line and column.
