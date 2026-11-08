# Notices

Learning Exercises is MIT-licensed code (see the repository's `LICENSE`) that ships text adapted from a
work licensed under the Creative Commons Attribution 4.0 International licence (CC BY 4.0,
https://creativecommons.org/licenses/by/4.0/).

## Learning Opportunities

- **Work:** [Learning Opportunities](https://github.com/DrCatHicks/learning-opportunities), by
  Dr. Cat Hicks.
- **Version used:** commit `3862d2e` (2026-08-19).
- **Licence:** CC BY 4.0. © Dr. Cat Hicks.
- **Not affiliated:** this plugin is not made, endorsed or reviewed by the author. CC BY grants no
  endorsement, and none is implied.

### What is reproduced, and what was changed

| File here | From upstream | Changes |
| --- | --- | --- |
| `content/PRINCIPLES.md` | `learning-opportunities/skills/learning-opportunities/resources/PRINCIPLES.md` | None. An attribution note is added above it. |
| `content/brief.md` | `learning-opportunities/skills/learning-opportunities/SKILL.md` | **Adapted.** Rewritten as the instructions a session agent receives after the user starts a session: the "when to offer" and "when not to offer" sections were removed (the plugin decides offers from bb's events and enforces the caps itself); "pause for input" now asks through an exercise card (a tool or the `bb learning ask` command) instead of relying on the model ending its message; orientation mode was removed (not in this version); the GitHub link to PRINCIPLES.md became the `bb learning principles` command; file references are written as workspace paths with a line or range, so they open as links; wording was shortened. The pause rule, the six exercise types, the techniques, code exploration with fading scaffolding and the facilitation guidelines keep their substance. |

The orientation-mode instructions in `content/orientation-session.md` come from the "Orientation mode"
section of Dr. Cat Hicks's `learning-opportunities/skills/learning-opportunities/SKILL.md`.

The upstream hook (`learning-opportunities-auto`) is not reproduced: the plugin's server replaces it.

## Orient

- **Work:** `orient`, by Dr. Michael Mullarkey, in the same repository
  ([`orient/skills/orient/SKILL.md`](https://github.com/DrCatHicks/learning-opportunities/blob/main/orient/skills/orient/SKILL.md)
  and `orient/skills/orient/resources/orient-bibliography.md`).
- **Version used:** commit `3862d2e` of that repository, the source this plugin adapts and links to.
  Upstream's own `SKILL.md` names [mcmullarkey/orient](https://github.com/mcmullarkey/orient) as the
  author's home for the skill.
- **Licence:** CC BY 4.0. © Dr. Michael Mullarkey.
- **Not affiliated:** this plugin is not made, endorsed or reviewed by the author.

| File here | From upstream | Changes |
| --- | --- | --- |
| `content/orient-builder.md` | `orient/skills/orient/SKILL.md` | **Adapted.** The steps that detect languages, explore the repository and choose key files, concepts, gotchas and two exercises are kept in substance, with their source notes. Rewritten as the brief for a hidden builder thread: it writes through the plugin's tools instead of a file (`orientation.md`), listings are captured by the plugin from the files rather than typed, the optional walkthrough replaces the showboat argument, and it must not edit, commit or ask questions. Shortened and reworded. |
| `content/orientation-session.md` | "Orientation mode" in `learning-opportunities/skills/learning-opportunities/SKILL.md` (Dr. Cat Hicks) | **Adapted.** The two-exercise orientation, in order, with a closing question, rewritten as the instructions of an orientation session thread: the orientation is passed in as data, changed listings are trusted over the orientation, and questions go through the exercise card. |

### Orient bibliography

`content/orient-builder.md` draws on the sources of `orient-bibliography.md`, and cites four of them inline
in its exploration steps (Spinellis 2003, Hermans 2021, Storey et al. 2006 and Spolsky); the other two
(Storey et al. 2021, Dagenais et al. 2010) inform it without an inline citation:

- Spinellis, D. (2003). *Code Reading: The Open Source Perspective*. Addison-Wesley.
- Hermans, F. (2021). *The Programmer's Brain*. Manning Publications.
- Storey, M.-A., et al. (2006). How Software Developers Use Tools, Cognitive Strategies, and
  Representations to Navigate Code. *IEEE Transactions on Software Engineering*.
- Storey, M.-A., Zimmermann, T., Bird, C., Czerwonka, J., Murphy, B., & Kalliamvakou, E. (2021). Towards a
  Theory of Software Developer Job Satisfaction and Perceived Productivity. *IEEE Transactions on
  Software Engineering*, 47(10), 2125-2142.
- Spolsky, J. Practitioner writing on reading unfamiliar codebases. https://www.joelonsoftware.com
- Dagenais, B., et al. (2010). Moving into a New Software Project: Strangers in a Strange Land. *ICSE 2010*.

## showboat

- **Work:** [showboat](https://github.com/simonw/showboat), by Simon Willison, commit `d531261`,
  Apache-2.0.
- **Use:** the walkthrough export follows showboat's document format (commentary, code blocks and their
  output blocks) and the plugin's Verify follows `showboat verify`'s behaviour: re-read the listed source
  and compare. No showboat code or text is shipped, so no Apache licence text ships with the plugin.
- **Test code:** `server/testing/showboat-grammar.ts` is a test-only port of the block rules of showboat's
  `markdown/parser.go` (`Parse`), so the exporter is checked against showboat's grammar. It is Apache-2.0
  derived code and carries the attribution in its header. Tests are not part of the built plugin.
- **Not affiliated:** this plugin is not made or endorsed by the author.

### Not included

`MEASURE-THIS.md`, the upstream playbook for measuring a team's learning, is licensed CC BY-SA 4.0 and
is **not** copied here. Read it upstream:
https://github.com/DrCatHicks/learning-opportunities/blob/main/learning-opportunities/docs/MEASURE-THIS.md
