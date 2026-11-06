# Notices

Learning Exercises is MIT-licensed code (see the repository's `LICENSE`) that ships text adapted from a
work licensed under the Creative Commons Attribution 4.0 International licence (CC BY 4.0,
https://creativecommons.org/licenses/by/4.0/).

## Learning Opportunities

- **Work:** [Learning Opportunities](https://github.com/DrCatHicks/learning-opportunities), by
  Dr. Cat Hicks (the `orient` skill in the same repository is by Dr. Michael Mullarkey; this plugin
  does not include it yet).
- **Version used:** commit `3862d2e` (2026-08-19).
- **Licence:** CC BY 4.0. © Dr. Cat Hicks.
- **Not affiliated:** this plugin is not made, endorsed or reviewed by the author. CC BY grants no
  endorsement, and none is implied.

### What is reproduced, and what was changed

| File here | From upstream | Changes |
| --- | --- | --- |
| `content/PRINCIPLES.md` | `learning-opportunities/skills/learning-opportunities/resources/PRINCIPLES.md` | None. An attribution note is added above it. |
| `content/brief.md` | `learning-opportunities/skills/learning-opportunities/SKILL.md` | **Adapted.** Rewritten as the instructions a session agent receives after the user starts a session: the "when to offer" and "when not to offer" sections were removed (the plugin decides offers from bb's events and enforces the caps itself); "pause for input" now asks through an exercise card (a tool or the `bb learning ask` command) instead of relying on the model ending its message; orientation mode was removed (not in this version); the GitHub link to PRINCIPLES.md became the `bb learning principles` command; file references are written as workspace paths with a line or range, so they open as links; wording was shortened. The pause rule, the six exercise types, the techniques, code exploration with fading scaffolding and the facilitation guidelines keep their substance. |

The upstream hook (`learning-opportunities-auto`) is not reproduced: the plugin's server replaces it.

### Not included

`MEASURE-THIS.md`, the upstream playbook for measuring a team's learning, is licensed CC BY-SA 4.0 and
is **not** copied here. Read it upstream:
https://github.com/DrCatHicks/learning-opportunities/blob/main/learning-opportunities/docs/MEASURE-THIS.md
