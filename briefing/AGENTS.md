# AGENTS.md

A bb plugin with one command, `bb briefing`: every root thread's opening message, latest user message,
latest agent reply and blocked sub-threads, each project's description, and the first mate's tasks by
state, as text that fits one voice-tool result (Handsfree cuts every tool result at 4,000 characters), or
as JSON. It is not a Paseo port. It has no UI, no settings, no storage and no host entry.

The repository root `AGENTS.md` covers what every plugin here shares. This file covers only what is
specific to `briefing`.

## Orientation

| File | What it owns |
| --- | --- |
| `server.ts` | Registers the CLI over `sdk-ports.ts`. Nothing else runs. |
| `server/cli.ts` | `bb briefing` (the root command), `bb briefing thread <id>`, `--json`. |
| `server/ports.ts` | `BriefingPorts`: every read the briefing makes, as an interface. |
| `server/sdk-ports.ts` | `BriefingPorts` over `bb.sdk`, each call with a timeout and the caller's signal. |
| `server/gather.ts` | Reads the briefing and the thread detail through the ports; one failed read is a gap and a line in `problems`, never a failed briefing. |
| `server/messages.ts` | Which `client/turn/requested` events are the user's own words; status lines. |
| `server/description.ts` | A project's description from the opening of a Markdown file. |
| `server/firstmate.ts` | firstmate-crew's `fleet.load` answer (a copy of the fields read) grouped by state. |
| `server/render.ts` | The text, at the most detailed level that fits `BUDGET`. |
| `server/text.ts` | Markdown, links, URLs and bb ids out; whole sentences. |
| `server/testing/fake-ports.ts` | An in-memory bb for the tests. |
| `shots/shots.mjs` | The live check (below). |

`npm test` runs the unit tests. `sdk-ports.test.ts` runs a whole briefing over a recording fake `bb.sdk`
and fails on any SDK call outside an allowlist of reads.

## Decisions

**Read-only, and the same for every caller.** The command never sends, writes or updates anything, and
ignores the caller's thread and project: Handsfree passes the thread on screen, and the briefing must not
depend on it. Keep every new read in `READS` in `sdk-ports.test.ts`; a write there is a design change.

**The user's messages are the events, not the outline.** bb's conversation outline lists user rows, but
they include bb's `[bb system]` notices and plugins' notes, and start after the last context clear. The
event log's `client/turn/requested` rows carry `initiator`, `systemMessageKind` and each part's
`visibility`, so `messages.ts` keeps only `initiator: "user"`, `systemMessageKind: "unlabeled"`, no
agent-only part (firstmate-crew's watch notes have one), and no `[bb …]` or "Relayed by bb" prefix. The
opening is the first such event; the latest is found paging back from the end, 100 events a page (bb's
cap), at most five pages. The agent's latest message is the outline's last assistant preview (bb caps it
at 200 characters, plenty for a sentence or two); the thread detail reads `threads.output` for the whole
reply and falls back to the preview when the last turn wrote none.

**FirstMate comes from firstmate-crew, not from its files.** `bb.sdk.plugins.callRpc` on firstmate-crew's
`fleet.load` returns its board: the parsed backlog joined to the crew, each crewmate's last status line,
and the suggestions. It only reads. The method is not registered as discoverable, but discovery is
opt-in listing only and `callRpc` reaches any method. `server/firstmate.ts` keeps a copy of the fields it
reads (zod drops the rest), so a change to `FleetSchema` in `firstmate-crew/shared/types.ts` that renames
or retypes one of them must change it too. The section is shown only when the first mate's thread is a
root thread. With firstmate-crew absent or turned off the briefing says nothing about it; with it
installed but not running, `problems` says so.

**The first mate's project is described by a fixed sentence.** Its home's `AGENTS.md` is the charter,
written to the first mate ("You are the first mate…") and followed by paths and rules, so it is not read.

**Descriptions are read on the machine that holds the project.** `files.read` with the project's checkout
(`projects.list` sources, the default one first), else a root thread's workspace on another machine; at
most two places, each one trying `AGENTS.md`, `CLAUDE.md`, `README.md` in turn. A machine that does not
answer within the call timeout is a line in `problems`.

**Sub-threads.** `experimental_listDescendants` gives every non-archived, visible thread below each root
in one call per 200 roots; the rows come from `threads.list({ threadIds })`. A child is named when it waits
on an interaction, failed, or, when idle, its latest reply's last line is `blocked:`, `needs-decision:` or
`failed:`. That reply is read for at most 60 idle children per briefing (20 per thread detail).

**The size budget is a fixed order of drops** (`LEVELS` and `attempts` in `render.ts`): sentences first,
then the user's latest message except where a thread needs the user, then full entries only for the first
eight and five threads, then the oldest threads down to fifteen, then descriptions and the remaining
messages, then the questions behind held tasks, then threads down to none, then a hard cut. `BUDGET` is
3,900 so Handsfree's own cut never fires. `leftOut` must name every drop a level makes; the tests check
the order and the budget with up to 300 threads.

## Live check

`cd tools/shots && npm run shots -- briefing --out "$TMPDIR/briefing-live"` starts a throwaway dev bb,
installs firstmate-crew from this repository and this plugin, seeds two projects, a first mate with a
backlog and two crewmates (one needing a decision, one blocked), root threads that are finished, failed,
waiting on a permission and archived, and twenty fillers, then calls `POST /api/v1/plugins/briefing/cli`
with `{ argv }` exactly as Handsfree's `run_plugin_command` does, with and without a thread on screen. It
asserts the selection, the grouping, the descriptions, the size and that no thread's event log changed, and
writes the outputs to the `--out` folder. It takes about 35 seconds and spends no model tokens.
