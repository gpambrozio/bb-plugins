# FirstMate port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Paseo `firstmate` plugin to bb as `@gpambrozio/bb-plugin-firstmate`: a first mate that is an ordinary bb thread, a crew of child threads it dispatches through `bb firstmate crew spawn`, and a board in a thread-panel tab.

**Architecture:** Pure logic (parsers, charter, templates, watches) is carried from `~/repositories/paseo-plugins/firstmate` with its tests. Everything that touched Paseo is rebuilt on narrow ports (`ThreadsPort`, `ProjectsPort`, `Store`) implemented once over `bb.sdk` and `bb.storage.kv`, so every new module is unit-tested with plain fakes. `server.ts` only wires; `app.tsx` registers a `threadPanelAction`, a `settingsSection` and ⌘K commands.

**Tech Stack:** TypeScript, `@get-bb/plugin-sdk` 0.5.29, zod 4, React (host-shimmed), Tailwind semantic classes, vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-firstmate-port-design.md`

## Global Constraints

- Everything runs from `firstmate/`; there is no root `package.json`.
- Package name `@gpambrozio/bb-plugin-firstmate`; plugin id `firstmate`; `engines: { "bb": ">=0.44", "bbPluginSdk": ">=0.5.29" }`.
- npm always with `--cache "$TMPDIR/npm-cache"` (root-owned files in `~/.npm`).
- Bundled imports (zod, anything else) in `dependencies`; host-shimmed packages (react, radix portals, sonner, vaul, clsx, tailwind-merge, class-variance-authority) are type-only `devDependencies`; `@get-bb/plugin-sdk` stays the scaffold's exact devDependency unless server code imports an SDK subpath.
- Import only public `@get-bb/plugin-sdk` entry points.
- Colour only through semantic Tailwind classes (`bg-background`, `text-muted-foreground`, `border-border`, `bg-card`, `text-destructive`).
- Never restart the bb server. A failed `bb plugin reload` keeps the old instance and exits 1 — read the exit code.
- Never `--no-verify`. Commit after every task on branch `firstmate-port`; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Porting a Paseo file means: copy it, delete Paseo imports and dead branches named in the task, keep its doc comments where they still hold, and copy its `*.test.ts` alongside.
- The first mate is found only by `Store.mateThreadId()`; nothing looks it up by metadata or title.
- Captain's words go with send mode `"auto"` (crew steer: `"steer"`); watch output with `"queue-if-active"`.

## Review Focus

1. **Home setting with `~` or a folder that does not exist yet** — expanded against `os.homedir()` and created on launch; a relative path is refused with a sentence. Test in Task 7.
2. **The stored first mate archived or deleted in bb** — the board shows "first mate gone" with Launch/Adopt, `crew spawn` refuses, watches wait; nothing falls back to metadata. Tests in Tasks 7, 8, 9.
3. **A child of the first mate with no `firstmate` metadata** (spawned with raw `bb thread spawn --parent-self`) — still a card (task null, Working/Idle by status), never dropped. Test in Task 8.
4. **`data/backlog.md` or `data/suggestions.md` missing, empty, or caught half-written** — empty lists, no throw, board still loads. Test in Task 8.
5. **`crew spawn --prompt-file` given a relative path, or a file that does not exist** — resolved against the CLI's `ctx.cwd` (the first mate's home), and a missing file is a clear error naming the resolved path, with nothing spawned. Test in Task 9.

---

## File Structure

```
firstmate/
  package.json  tsconfig.json  vitest.config.ts  PLUGIN_OVERVIEW.md  README.md  AGENTS.md  CHANGELOG.md
  scripts/gen-templates.mjs            templates/ → server/templates.generated.ts
  templates/                           ported from Paseo; charter rewritten (Task 11)
  shared/types.ts                      zod schemas + types shared by server and app, CREW_METADATA
  shared/contract.ts                   rpcContract (defineRpcContract)
  server.ts                            wiring only
  server/templates.ts (+generated)     TEMPLATES, readTemplate, fill, withoutNotes, message
  server/backlog.ts  suggestions.ts  crew-report.ts  serialize.ts  files.ts          ported (Task 4)
  server/charter.ts  charter-file.ts  home.ts  watch-files.ts  watch-schedule.ts      ported (Task 5)
  server/watch-run.ts  watches.ts                                                     ported (Task 6)
  server/ports.ts                      ThreadsPort, ProjectsPort, ThreadInfo, SpawnArgs
  server/bb-ports.ts                   the ports over bb.sdk
  server/store.ts                      Store over bb.storage.kv
  server/settings.ts                   bb.settings.define descriptors, homePath()
  server/mate.ts                       launch, adopt, release, restart, command, ask
  server/fleet.ts                      cards, columns, ReportCache, loadFleet
  server/crew.ts                       steer, interrupt, end, relaunch, note
  server/cli.ts                        bb firstmate crew spawn | tell
  server/watch-delivery.ts             deliver(): idle → one queue-if-active send
  app.tsx                              definePluginApp: slots and commands
  app/panel.tsx  board.tsx  card.tsx  suggestions.tsx  watches.tsx  crew-panel.tsx  settings-section.tsx
  app/suggestion-removals.ts           ported (pure)
  app/folds.ts                         column fold state in localStorage (pure core)
```

---

### Task 1: Scaffold the package

**Files:**
- Create: `firstmate/` (via `bb plugin new`), `firstmate/vitest.config.ts`
- Modify: `firstmate/package.json`, `firstmate/tsconfig.json`
- Delete: the scaffold's todo example (`server.ts` body, `app.tsx` body, `skills/example-todos/`)

**Interfaces:**
- Produces: a package where `npm test`, `npx tsc --noEmit` and `bb plugin build` pass; `server.ts` default-exports `async function plugin(bb: BbPluginApi) {}`; `app.tsx` default-exports `definePluginApp(() => {})`.

- [ ] **Step 1:** From the repo root run `bb plugin new firstmate`, then `mv bb-plugin-firstmate firstmate`.
- [ ] **Step 2:** In `package.json` set `"name": "@gpambrozio/bb-plugin-firstmate"`, `"version": "0.1.0"`, `"license": "MIT"`, the `engines` from Global Constraints, `bb.name` `"FirstMate"`, `bb.description` `"Talk to one first mate agent that runs a crew of bb threads, each in its own worktree, with a live board of the crew."`, `bb.branding.icon` `"Ship"`, and scripts `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`, `"build": "bb plugin build"`, `"gen:templates": "node scripts/gen-templates.mjs"`. Add `"files": ["server.ts","server/","shared/","app.tsx","app/","components/","templates/","dist/","PLUGIN_OVERVIEW.md","CHANGELOG.md","!**/*.test.ts"]`.
- [ ] **Step 3:** Delete the todo example and `skills/example-todos/`; leave `server.ts` and `app.tsx` as the empty factories above. Remove the `bb.skills` key if the scaffold wrote one.
- [ ] **Step 4:** `npm install --include=dev --cache "$TMPDIR/npm-cache"`, then add vitest: `npm install -D vitest --cache "$TMPDIR/npm-cache"`. Write `vitest.config.ts` with `test: { include: ["**/*.test.ts"], exclude: ["node_modules/**", "dist/**"] }`.
- [ ] **Step 5:** Run `npx tsc --noEmit && npx vitest run --passWithNoTests && bb plugin build`. Expected: all three exit 0.
- [ ] **Step 6:** `bb plugin install path:$PWD`, then `bb plugin list`. Expected: `firstmate` listed with status `running`.
- [ ] **Step 7:** Commit `firstmate: scaffold the package`.

### Task 2: Check the two open platform questions

No product code. Findings go into the spec's *Open items* section and decide whether Task 8 ports the steer relay and whether Task 12 registers `/fm`.

- [ ] **Step 1: Captain-started child turn → parent notified?** In a scratch directory under `$TMPDIR`, `git init` a repo with one commit and `bb project create` it. Spawn a parent: `bb thread spawn --project <p> --prompt "Reply OK and wait." --title fm-check-parent`. Spawn its child: `bb thread spawn --project <p> --parent-thread <parent> --prompt "Reply OK." --title fm-check-child`. Wait for both idle (`bb thread wait`). Then `bb thread tell <child> "Reply DONE."` (as the user, not the parent), wait for the child idle, and read `bb thread log <parent> --format minimal --limit 5`. Expected: a child-finished notice after the tell. Record yes/no.
- [ ] **Step 2: Slash command via composer customization?** Read `app.composer.customize` in `firstmate/node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts` for any command/slash registration. Record yes (with the exact API) or no.
- [ ] **Step 3:** Archive both scratch threads (`bb thread archive`) and delete the scratch project.
- [ ] **Step 4:** Update the spec's *Open items* with both answers; commit `docs: record firstmate platform checks`.

### Task 3: Shared types and templates

**Files:**
- Create: `shared/types.ts`, `scripts/gen-templates.mjs`, `server/templates.ts`, `server/templates.generated.ts`, `server/templates.test.ts`
- Copy: `templates/` from Paseo, then rename `templates/parts/crew-mode-open.md` → `crew-reasoning-open.md` and `crew-mode-chosen.md` → `crew-reasoning-chosen.md` (placeholder `{{crewReasoning}}`), and add an empty-for-now `templates/messages/board-note.md` (filled in Task 11).
- Do not copy: `templates/messages/steer-relay*.md` (unless Task 2 Step 1 said "no").

**Interfaces:**
- Produces (`shared/types.ts`), zod schema + inferred type for each:
  - `CREW_METADATA = { role: "role", crewRole: "crew", mateRole: "first-mate", task: "task", kind: "kind", project: "project" } as const` (keys inside the plugin's own metadata namespace)
  - `CrewState` = `"working"|"needs-decision"|"blocked"|"paused"|"done"|"failed"|"resolved"`
  - `COLUMN_IDS = ["queued","working","blocked","parked","done","failed","idle"] as const`, `ColumnId`
  - `ThreadStatus` = `"pending"|"idle"|"starting"|"active"|"stopping"|"error"`
  - `BacklogItem` — Paseo's shape with `agentId` renamed `threadId`
  - `CrewReport { state: CrewState; text: string }`
  - `CrewSummary { threadId; title: string|null; status: ThreadStatus; pendingInteractions: number; projectId; environmentId: string|null; updatedAt: number; task: string|null; kind: string|null; project: string|null }`
  - `FleetCard { key; column: ColumnId; taskId: string|null; title; project: string|null; kind: string|null; backlog: BacklogItem|null; crew: CrewSummary|null; report: CrewReport|null; url: string|null }`
  - `Suggestion { label; prompt }`, `Project` (Paseo's), `WatchResult`, `WatchSummary` (Paseo's), `CharterState` (Paseo's `charter-file` shape)
  - `Fleet { home: string; homeReady: boolean; mate: { threadId: string; status: ThreadStatus; title: string|null } | null; mateMissing: boolean; cards: FleetCard[]; suggestions: Suggestion[]; charter: CharterState; watches: WatchSummary[] }`
  - `WATCHES_DIR = "watches"`, `STATE_DIR = ".firstmate"`
- Produces (`server/templates.ts`): `TEMPLATES` (Paseo's keys, `crewModeOpen/Chosen` → `crewReasoningOpen/Chosen`, plus `boardNote: "messages/board-note.md"`, minus the steer-relay keys), `type TemplatePath`, `readTemplate(path: TemplatePath): Promise<string>`, `withoutNotes(text): string`, `fill(template, values): string`, `message(path, values?): Promise<string>` — same signatures as Paseo; `templatesDirectory` is gone.

- [ ] **Step 1: Write `server/templates.test.ts`** — port Paseo's test, replacing the folder lookup with:
  - `it("TEMPLATES names exactly the files in templates/")` — walk `templates/` from `new URL("../templates/", import.meta.url)` and compare to `Object.values(TEMPLATES)` sorted.
  - `it("the generated module matches templates/ byte for byte")` — for every path, `await readTemplate(p)` equals `readFileSync(templates/p, "utf8")`.
  - `it("package.json ships templates/")` — `files` includes `"templates/"`.
  - Paseo's `fill` cases (single pass: a value containing `{{title}}` arrives as written; unknown names left alone) and `withoutNotes`.
- [ ] **Step 2:** `npx vitest run server/templates.test.ts` — FAIL (module missing).
- [ ] **Step 3:** Write `scripts/gen-templates.mjs`: walks `templates/` recursively, sorted, and writes `server/templates.generated.ts` exporting `export const TEMPLATE_FILES: Readonly<Record<string, string>> = { "<relative path>": <JSON.stringify(content)>, … }` with a header comment saying it is generated by `npm run gen:templates` and not to edit it. Write `server/templates.ts` so `readTemplate` resolves from `TEMPLATE_FILES` and rejects with `Unknown template <path>` for a missing key. Write `shared/types.ts`.
- [ ] **Step 4:** `npm run gen:templates && npx vitest run server/templates.test.ts && npx tsc --noEmit` — PASS.
- [ ] **Step 5:** Commit `firstmate: shared types and generated templates`.

### Task 4: Port the pure parsers and file helpers

**Files:**
- Port with tests: `server/backlog.ts`, `server/suggestions.ts`, `server/crew-report.ts`, `server/serialize.ts`, `server/files.ts`
- From `files.ts` keep only `cleanRelative`, `resolveInHome`, `readTextFile`, `FileChangedError`, `WriteHooks`, `writeTextFile`, `replaceTextIfUnchanged`, `requireHome`; drop `listDirectory`, `findFiles`, `MAX_EDITABLE_BYTES` import (inline the 1 MB constant as `MAX_TEXT_BYTES = 1024 * 1024`) and their tests.

**Interfaces:**
- Consumes: `shared/types.ts` (`BacklogItem`, `Suggestion`, `CrewReport`).
- Produces: `parseBacklog(md): BacklogItem[]`, `MAX_SUGGESTIONS = 8`, `parseSuggestions(md): Suggestion[]`, `withoutSuggestion(md, target): string | null`, `parseCrewReport(message, window = 4): CrewReport | null`, `reportUrl(text): string | null`, `serialized<T>(key, task): Promise<T>`, and the kept `files.ts` exports with Paseo's signatures.

- [ ] **Step 1:** Copy the five modules and their tests. In `backlog.test.ts` add: `it("reads (thread: …) as the item's threadId")` with a line `- [T3] Fix login (project: web) (thread: thr_abc123)` → `threadId === "thr_abc123"`, and `it("still reads the Paseo (agent: …) spelling as threadId")`.
- [ ] **Step 2:** `npx vitest run server/` — the new backlog cases FAIL.
- [ ] **Step 3:** In `backlog.ts` rename the field to `threadId` and accept both `thread:` and `agent:` keys. Fix imports to `../shared/types`.
- [ ] **Step 4:** `npx vitest run server/ && npx tsc --noEmit` — PASS.
- [ ] **Step 5:** Commit `firstmate: port backlog, suggestions, crew report and file helpers`.

### Task 5: Port charter, home and watch files

**Files:**
- Port with tests: `server/charter.ts`, `server/charter-file.ts`, `server/home.ts`, `server/watch-files.ts`, `server/watch-schedule.ts`

**Interfaces:**
- Consumes: Task 3 templates, Task 4 `files`/`suggestions`/`backlog`.
- Produces:
  - `CharterValues { home: string; crewProvider: string; crewReasoning: string }` (`crewModeId` renamed; both empty means "open"), `pluginCharter()`, `renderCharter(values, charter?)` — fills `{{home}}`, `{{crewProviderRule}}`, `{{crewReasoningRule}}`, and the `CREW_METADATA` names the charter uses.
  - `charter-file`: Paseo's exports unchanged (`fingerprint`, `assessCharter`, `readCharterState`, `syncCharter`, `writeNewCharter`, `acknowledgeCharter`, `CHARTER_FILE`, `NEW_CHARTER_FILE`), except that `CharterState` is imported from `shared/types` rather than declared here.
  - `home`: `HomeConfig { crewProvider: string; crewReasoning: string }`; `prepareHome(home: string, config: HomeConfig): Promise<void>`; `isHomeReady`, `readOpening`, `readBacklog`, `readSuggestions`, `REMOVE_ATTEMPTS`, `removeSuggestion`, `parseProjects`, `readProjects` unchanged.
  - `watch-files`, `watch-schedule`: Paseo's exports unchanged.

- [ ] **Step 1:** Copy the modules and tests. Replace `FirstmateConfig` with `HomeConfig`; replace `crewModeId` with `crewReasoning` in code and tests; in `prepareHome` also `mkdir(join(home, STATE_DIR), { recursive: true })`. Add to `home.test.ts`: `it("creates .firstmate/ in a new home")`.
- [ ] **Step 2:** `npx vitest run server/` — the new case and any renamed expectations FAIL.
- [ ] **Step 3:** Make them pass; `watch-files` must not list anything under `.firstmate/` (it only reads `watches/`, confirm no change needed).
- [ ] **Step 4:** `npx vitest run server/ && npx tsc --noEmit` — PASS.
- [ ] **Step 5:** Commit `firstmate: port charter, home and watch files`.

### Task 6: Port the watch runner

**Files:**
- Port with tests: `server/watch-run.ts`, `server/watches.ts`, `server/pr-watch.test.ts`
- Do not port: `server/watch-service.ts` (replaced in Task 10).

**Interfaces:**
- Consumes: Task 5 `watch-files`, `watch-schedule`; Task 3 `message`.
- Produces: `runWatchScript`, `RunOptions`, `RunResult` unchanged; from `watches.ts`: `WATCH_TIMEOUT_MS`, `MAX_OUTPUT_CHARS = 16000`, `MAX_ERROR_CHARS = 1500`, `MAX_QUEUED = 20`, `MAX_MESSAGE_CHARS = 32000`, `QueuedNote`, `DeliveryOutcome = "sent" | "wait"`, `clip`, `quoted`, `watchNote`, `fitWatchNote`, `readState`, and `class WatchRunner` with `WatchRunnerOptions { home: () => Promise<string | null>; disabled: () => Promise<readonly string[]>; deliver: (text: string) => Promise<DeliveryOutcome>; stateFile: string; scriptStateRoot: string; now?; run?; timeoutMs?; env? }` and public `start(): () => void`, `stop(): void`, `tick(at: Date): Promise<void>`, `flush(): Promise<void>`, `summaries(): Promise<WatchSummary[]>` (Paseo's summary method, whatever its current name — keep it).
- Removed: `AFTER_TURN_DELAYS_MS` and `flushAfterTurn` — delivery is triggered by the first mate's `thread.idle` (Task 10) and every tick.

- [ ] **Step 1:** Copy the files and tests; delete the `AFTER_TURN_DELAYS_MS`/`flushAfterTurn` code and the tests that cover only them. Keep `WATCH_MESSAGE_ID_PREFIX` out (bb's chat does not fold watch messages).
- [ ] **Step 2:** `npx vitest run server/watches.test.ts server/pr-watch.test.ts` — PASS (pure carry-over; any failure is a porting mistake to fix, not a test to change).
- [ ] **Step 3:** `npx tsc --noEmit` — PASS.
- [ ] **Step 4:** Commit `firstmate: port the watch runner`.

### Task 7: Ports, store, settings and the first mate lifecycle

**Files:**
- Create: `server/ports.ts`, `server/bb-ports.ts`, `server/store.ts`, `server/settings.ts`, `server/mate.ts`, `server/mate.test.ts`, `server/settings.test.ts`, `server/testing/fakes.ts`

**Interfaces:**
- Produces (`server/ports.ts`):
  ```ts
  export interface ThreadInfo { id: string; title: string | null; status: ThreadStatus; parentThreadId: string | null;
    projectId: string; environmentId: string | null; updatedAt: number; archivedAt: number | null }
  export type SendMode = "auto" | "steer" | "queue-if-active";
  export type SpawnEnvironment = { kind: "worktree" } | { kind: "reuse"; environmentId: string } | { kind: "path"; path: string };
  export interface SpawnArgs { projectId: string; title: string; prompt: string; parentThreadId?: string;
    environment: SpawnEnvironment; providerId?: string; model?: string; reasoningLevel?: string;
    metadata: Record<string, string> }
  export interface ThreadsPort {
    get(id: string): Promise<ThreadInfo | null>;            // null when missing, deleted or archived
    children(parentId: string): Promise<ThreadInfo[]>;       // non-archived children
    metadata(id: string): Promise<Record<string, unknown>>;  // this plugin's namespace
    pendingInteractions(id: string): Promise<number>;
    lastText(id: string): Promise<string | null>;
    spawn(args: SpawnArgs): Promise<ThreadInfo>;
    send(id: string, text: string, mode: SendMode): Promise<"sent" | "queued">;
    stop(id: string): Promise<void>; archive(id: string): Promise<void>;
    clearContext(id: string): Promise<void>; pin(id: string): Promise<void>;
  }
  export interface ProjectsPort { findByPath(path: string): Promise<{ id: string } | null>;
    create(name: string, path: string): Promise<{ id: string }> }
  ```
- Produces (`server/store.ts`): `interface Store { mateThreadId(): Promise<string | null>; setMateThreadId(id: string | null): Promise<void>; disabledWatches(): Promise<string[]>; setDisabledWatches(names: string[]): Promise<void> }`, `createStore(kv: PluginKvStorage): Store` (keys `mateThreadId`, `disabledWatches`).
- Produces (`server/settings.ts`): `SETTINGS` descriptors — `homeDirectory` (string, default `"~/FirstMate"`), `crewProvider` (string, default `""`), `crewModel` (string, default `""`), `crewReasoning` (select `["default","low","medium","high","xhigh","max"]`, default `"default"`), `refreshSeconds` (number, default `10`); `type FirstmateSettings`; `homePath(setting: string): string` (expands a leading `~`, throws `Home directory must be an absolute path or start with ~: <value>` otherwise); `homeConfig(s: FirstmateSettings): HomeConfig` (`crewProvider` = `"provider/model"` when both set, else `""`; `crewReasoning` = `""` for `"default"`).
- Produces (`server/mate.ts`), all taking `deps: MateDeps = { threads: ThreadsPort; projects: ProjectsPort; store: Store; settings: () => Promise<FirstmateSettings> }`:
  - `MATE_TITLE = "First mate"`, `PROJECT_NAME = "FirstMate"`
  - `resolveMate(deps): Promise<ThreadInfo | null>` — stored id → `threads.get`; null when unset or gone.
  - `launchMate(deps, pick: { providerId: string; model: string; reasoningLevel?: string }): Promise<ThreadInfo>` — under `serialized("mate")`: refuse with `A first mate is already aboard (<id>). Release it first.` when `resolveMate` is non-null; `mkdir -p` home; `prepareHome`; `projects.findByPath(home) ?? projects.create(PROJECT_NAME, home)`; `threads.spawn({ environment: { kind: "path", path: home }, title: MATE_TITLE, prompt: await readOpening(home), metadata: { role: "first-mate" }, … })`; `pin`; `setMateThreadId`.
  - `adoptMate(deps, threadId): Promise<ThreadInfo>` — refuse when a live first mate exists or the thread does not resolve; `prepareHome`; store.
  - `releaseMate(deps): Promise<void>` — `setMateThreadId(null)` only.
  - `restartMate(deps): Promise<void>` — under `serialized("mate")`; refuse `No first mate aboard.` / `Restart refused: the first mate is mid-turn.` unless status is `"idle"` or `"error"`; `clearContext`; `send(id, opening + "\n\n" + restartNote, "auto")`.
  - `MateCommand = "bearings" | "ahoy"`; `commandText(command, args): Promise<string>` (Paseo's; `-args` template when `args.trim()` non-empty).
  - `askMate(deps, text): Promise<void>` — `requireMate` then `send(id, text, "auto")`.
  - `requireMate(deps): Promise<ThreadInfo>` — throws `No first mate aboard. Launch one in FirstMate settings.`
- `server/testing/fakes.ts`: `fakeThreads()` (in-memory `ThreadsPort` recording calls, with helpers to add threads/metadata/texts), `fakeProjects()`, `memoryStore()`.
- `server/bb-ports.ts`: `bbThreads(sdk: PluginBbSdk): ThreadsPort`, `bbProjects(sdk): ProjectsPort`. Mapping: `get` → `sdk.threads.get`, 404 → null, `archivedAt`/`deletedAt` set → null; `children` → `sdk.threads.list({ parentThreadId, archived: false })`; `metadata` → `sdk.threads.getPluginMetadata({ threadId })`; `pendingInteractions` → `sdk.threads.interactions.list({ threadId })` length of pending entries; `lastText` → `sdk.threads.output`; `spawn` environment → `{ type: "host", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } }` / `{ type: "reuse", environmentId }` / `{ type: "host", workspace: { type: "unmanaged", path } }`, `pluginMetadata: metadata`; `send` → `sdk.threads.send({ threadId, mode, input: [text input] })` returning its `delivery`; `clearContext` → `sdk.threads.clearContext`; `pin` → `sdk.threads.pin`; projects via `sdk.projects.list`/`create` with the source shape from `createProjectRequestSchema` in the SDK types (a local path on the server host). Not unit-tested; exercised in Task 13.

- [ ] **Step 1: Write `server/settings.test.ts`:** `homePath("~/FirstMate")` → `join(homedir(), "FirstMate")`; `homePath("/abs")` → `"/abs"`; `homePath("rel")` throws the sentence above; `homeConfig` maps provider+model and `"default"` as specified.
- [ ] **Step 2: Write `server/mate.test.ts`** with the fakes:
  - `launch creates the project and a pinned first mate in the home, and stores its id` — asserts spawn args (`environment.kind === "path"`, `title === "First mate"`, `metadata.role === "first-mate"`, prompt equals the home's opening), `pin` called, store holds the id, `.firstmate/` exists in the (temp) home.
  - `launch reuses an existing project at the home path`.
  - `launch refuses while a stored first mate still resolves`.
  - `launch is serialized: two concurrent launches spawn once`.
  - `resolveMate ignores a first-mate-metadata thread that is not the stored id` and `returns null when the stored thread is gone` (Review Focus 2).
  - `restart refuses mid-turn` for status `"active"`, `"starting"`, `"pending"`, `"stopping"`; `restart clears context then sends opening + restart note with mode auto`.
  - `release forgets the id and touches no thread`.
  - `adopt refuses an unknown thread`.
  - `a spawn failure leaves no stored id and the error says the first mate could not be started, with the cause`.
- [ ] **Step 3:** `npx vitest run server/settings.test.ts server/mate.test.ts` — FAIL.
- [ ] **Step 4:** Implement `ports.ts`, `store.ts`, `settings.ts`, `mate.ts`, `testing/fakes.ts`, `bb-ports.ts`.
- [ ] **Step 5:** `npx vitest run && npx tsc --noEmit` — PASS.
- [ ] **Step 6:** Commit `firstmate: ports, store, settings and first mate lifecycle`.

### Task 8: The fleet and crew actions

**Files:**
- Create: `server/fleet.ts`, `server/fleet.test.ts`, `server/crew.ts`, `server/crew.test.ts`

**Interfaces:**
- Consumes: Task 7 ports, `resolveMate`, `requireMate`; Task 5 `readBacklog`, `readSuggestions`, `readCharterState`, `isHomeReady`; Task 4 `parseCrewReport`, `reportUrl`; Task 6 `WatchRunner.summaries`.
- Produces (`fleet.ts`):
  - `class ReportCache { constructor(threads: ThreadsPort); report(crew: CrewSummary): Promise<CrewReport | null>; remember(threadId: string, updatedAt: number, text: string | null): void }` — fetches `lastText` only when `updatedAt` moved and status is `"idle"` or `"error"`; `remember` is fed by `thread.idle`'s `lastAssistantText` (Task 10).
  - `crewColumn(crew: CrewSummary, report: CrewReport | null): ColumnId` — Paseo's rules with bb statuses: `pendingInteractions > 0` → blocked; `"error"` → failed; `"active" | "starting" | "pending" | "stopping"` → working; else the status-line branch unchanged (ended turn with no line, or `done`/`resolved` → idle).
  - `backlogColumn(item: BacklogItem): ColumnId` (Paseo's).
  - `buildCards(backlog: readonly BacklogItem[], crew: readonly { summary: CrewSummary; report: CrewReport | null }[]): FleetCard[]` — join on `summary.task === item.id` or `item.threadId === summary.threadId`; leftovers on either side are their own cards.
  - `loadFleet(deps: FleetDeps): Promise<Fleet>` with `FleetDeps = MateDeps & { reports: ReportCache; watches: () => Promise<WatchSummary[]> }`.
- Produces (`crew.ts`), each first checks the thread is a child of the stored first mate, else throws `<id> is not in the first mate's crew.`:
  - `steerCrew(deps, threadId, text)` → `send(threadId, text, "steer")`
  - `interruptCrew(deps, threadId)` → `stop`
  - `endCrew(deps, threadId, confirmed: boolean): Promise<{ ended: boolean; needsConfirmation: boolean }>` — archives when the joined backlog item is in `done` or `confirmed`; otherwise returns `needsConfirmation: true` and archives nothing.
  - `relaunchCrew(deps, threadId, note)` → `askMate` with `message(TEMPLATES.relaunch, { title, task, threadId, environmentId, note })`
  - `noteCrew(deps, threadId, note)` → `askMate` with `message(TEMPLATES.boardNote, { title, threadId, note })`

- [ ] **Step 1: Write `server/fleet.test.ts`** (temp home + fakes):
  - `crewColumn` table: each bb status × report state → expected column, including `pendingInteractions: 1` on an `"active"` thread → blocked, and `done:` on an idle thread → idle.
  - `buildCards joins by metadata task and by backlog (thread: …)`; `a backlog item with no crew is its own card in backlogColumn`.
  - `a child with no firstmate metadata is still a card` (Review Focus 3): task null, column from status.
  - `loadFleet with no stored first mate` → `mate: null, mateMissing: false, cards` from backlog only; `with a stored id that no longer resolves` → `mateMissing: true`.
  - `loadFleet with backlog.md and suggestions.md missing, or empty` → `cards: []`, `suggestions: []`, no throw (Review Focus 4).
  - `ReportCache fetches lastText once per updatedAt and never mid-turn`; `remember() spares the fetch`.
- [ ] **Step 2: Write `server/crew.test.ts`:** steer uses mode `"steer"`; interrupt calls `stop`; `endCrew` on a non-Done item without confirmation returns `needsConfirmation` and archives nothing, with `confirmed: true` archives; any action on a thread that is not a child of the first mate throws the sentence; relaunch and note send one `"auto"` message to the first mate containing the thread id.
- [ ] **Step 3:** `npx vitest run server/fleet.test.ts server/crew.test.ts` — FAIL.
- [ ] **Step 4:** Implement `fleet.ts` (drop Paseo's `closingText`, `listAgents`, `readAgentTools`, `sameDirectory`) and `crew.ts`. If Task 2 found that a captain-started child turn does **not** notify the parent, also port `CaptainSteers`/`relayText` and the `steer-relay*.md` templates here, triggered by `thread.idle` of the steered child in Task 10, with Paseo's relay tests.
- [ ] **Step 5:** `npx vitest run && npx tsc --noEmit` — PASS.
- [ ] **Step 6:** Commit `firstmate: fleet board and crew actions`.

### Task 9: The `bb firstmate` CLI

**Files:**
- Create: `server/cli.ts`, `server/cli.test.ts`

**Interfaces:**
- Consumes: Task 7 `MateDeps`, `requireMate`, `askMate`, `homeConfig`.
- Produces: `firstmateCli(deps: MateDeps): PluginCliRegistration` (built with `defineCli` if its spec fits, else a hand-written `run`), name `"firstmate"`, commands:
  - `crew spawn --task <id> --project <project-id-or-name> --prompt-file <path> [--title <t>] [--kind <k>] [--environment <env-id>] [--provider <id> --model <m>] [--reasoning <level>]` — refuses unless `ctx.threadId` equals the stored first mate (`crew spawn is only for the first mate (caller <id> is not it).`; no `ctx.threadId` → `crew spawn must run inside the first mate's thread.`); resolves `--prompt-file` against `ctx.cwd` and fails `Prompt file not found: <absolute path>` before spawning; resolves `--project` by id or exact name; applies settings' `crewProvider`/`crewModel`/`crewReasoning` unless flags given; spawns with `parentThreadId` = first mate, environment `worktree` or `reuse`, metadata `{ role: "crew", task, kind, project }`, title `--title` or `<task>: <first line of the brief>`; prints the new thread id (and JSON with `--json`).
  - `tell <message…>` — `askMate` with the joined words; usable from any thread or terminal.

- [ ] **Step 1: Write `server/cli.test.ts`:**
  - `crew spawn from the first mate spawns a worktree child with crew metadata and prints its id`.
  - `crew spawn applies the settings' crew model unless --provider/--model are given`.
  - `crew spawn --environment reuses that environment` (the relaunch path).
  - `crew spawn from another thread is refused and spawns nothing`; `without ctx.threadId is refused`.
  - `crew spawn with the stored first mate gone is refused` (Review Focus 2).
  - `--prompt-file relative to ctx.cwd is read from there; a missing file names the resolved path and spawns nothing` (Review Focus 5).
  - `tell sends one auto message to the first mate`.
- [ ] **Step 2:** `npx vitest run server/cli.test.ts` — FAIL.
- [ ] **Step 3:** Implement `server/cli.ts`.
- [ ] **Step 4:** `npx vitest run && npx tsc --noEmit` — PASS.
- [ ] **Step 5:** Commit `firstmate: bb firstmate crew spawn and tell`.

### Task 10: Server wiring and watch delivery

**Files:**
- Create: `shared/contract.ts`, `server/watch-delivery.ts`, `server/watch-delivery.test.ts`
- Modify: `server.ts`

**Interfaces:**
- Consumes: everything above.
- Produces (`shared/contract.ts`): `rpcContract = defineRpcContract({ … })` with zod input/output for `fleet.load` (→ `Fleet`), `mate.launch` ({providerId, model, reasoningLevel?} → {threadId}), `mate.adopt` ({threadId}), `mate.release`, `mate.restart`, `mate.command` ({command: "bearings"|"ahoy", args: string}), `mate.ask` ({text}), `crew.steer` ({threadId, text}), `crew.interrupt` ({threadId}), `crew.end` ({threadId, confirmed} → {ended, needsConfirmation}), `crew.relaunch` ({threadId, note}), `crew.note` ({threadId, note}), `suggestion.remove` (Suggestion → Suggestion[]), `charter.compare` (→ {path}), `charter.acknowledge`, `watch.toggle` ({name, enabled} → WatchSummary[]). `server.ts` re-exports it: `export { rpcContract } from "./shared/contract"`.
- Produces (`watch-delivery.ts`): `createDeliver(deps: { threads: ThreadsPort; store: Store }): (text: string) => Promise<DeliveryOutcome>` — `"wait"` when no stored first mate resolves or its status is not `"idle"`; otherwise one `send(id, text, "queue-if-active")` and `"sent"`.
- `server.ts` wiring:
  - `settings = bb.settings.define(SETTINGS)`; `store = createStore(bb.storage.kv)`; ports from `bb.sdk` built lazily inside handlers/services (never in the factory body).
  - `bb.rpc.register(rpcContract, handlers)` — each handler delegates to Tasks 7–9 functions; `charter.compare` calls `writeNewCharter` and returns `NEW_CHARTER_FILE`.
  - `bb.cli.register(firstmateCli(deps))`.
  - `bb.background.service("watches", { start(signal) })` — builds a `WatchRunner` for the current home (`stateFile` `<home>/.firstmate/watches.json`, `scriptStateRoot` `<home>/.firstmate/watch-state`, `deliver` from `createDeliver`, `disabled` from the store), `start()`s it, and resolves when `signal` aborts after `stop()`. `settings.onChange` with a changed `homeDirectory` stops and rebuilds the runner.
  - `bb.events.on("thread.idle" | "thread.failed" | "thread.created" | "thread.active", …)` — when the thread is the first mate or its child: `reports.remember(...)` on idle for children, `runner.flush()` on idle for the first mate, then `bb.realtime.publish("fleet", { at: Date.now() })`.
  - On load, `prepareHome` for an existing stored first mate's home (so a plugin upgrade re-renders `AGENTS.md` and syncs the charter), inside the service's start, errors logged.
  - `bb.onDispose` stops the runner and anything else started.

- [ ] **Step 1: Write `server/watch-delivery.test.ts`:** no stored first mate → `"wait"`, no send; first mate `"active"` → `"wait"`; `"idle"` → exactly one send with mode `"queue-if-active"` and `"sent"`; stored id gone → `"wait"`.
- [ ] **Step 2:** `npx vitest run server/watch-delivery.test.ts` — FAIL.
- [ ] **Step 3:** Implement `watch-delivery.ts`, `shared/contract.ts`, and `server.ts`.
- [ ] **Step 4:** `npx vitest run && npx tsc --noEmit && bb plugin build` — PASS.
- [ ] **Step 5:** `bb plugin reload firstmate; echo $?` → `0`; `bb plugin list` → `running`; `bb plugin rpc list firstmate` lists the 16 methods; `bb plugin rpc call firstmate fleet.load --input-file <(echo '{}')` returns a `Fleet` with `mate: null`.
- [ ] **Step 6:** Commit `firstmate: server wiring and watch delivery`.

### Task 11: Rewrite the charter and messages for bb

**Files:**
- Modify: `templates/data/charter.md`, `templates/data/opening.md`, `templates/messages/relaunch.md`, `templates/messages/restart-note.md`, `templates/messages/board-note.md`, `templates/parts/crew-*.md`, `templates/watches/README.md`, `templates/AGENTS.md`
- Regenerate: `server/templates.generated.ts`
- Test: `server/charter.test.ts` (extend)

The charter is a contract with a model; rewrite, do not find-and-replace. Keep every section's intent from the Paseo charter; change only what the platform changes.

- [ ] **Step 1: Extend `server/charter.test.ts`:** `renderCharter leaves no {{placeholder}}`; `the rendered charter never mentions paseo, MCP tools, create_agent, send_agent_prompt, archive_agent, create_heartbeat, or labels` (case-insensitive); `it names bb firstmate crew spawn, bb thread tell, bb thread show, bb thread output and bb thread list --parent-thread`; `the hard rules survive`: contains "never merge", "never write to a project", "unlanded".
- [ ] **Step 2:** `npm run gen:templates && npx vitest run server/charter.test.ts` — FAIL.
- [ ] **Step 3:** Rewrite:
  - §0 *You live in bb*: bb is where projects, threads and environments are (`bb project list`, `bb thread list --parent-thread $BB_THREAD_ID`, `bb thread show <id>`); your crew are your child threads; bb tells you when one finishes a turn, fails or is interrupted — a message arrives in your thread; `$BB_THREAD_ID` is you.
  - Dispatch: write `data/<task>/brief.md`, then `bb firstmate crew spawn --task <id> --project <project> --prompt-file data/<task>/brief.md [--kind …]`; record `(thread: <id>)` on the backlog line; steer with `bb thread tell <id> --message-file …`; read a finished worker with `bb thread output <id>`; stop with `bb thread stop <id>`; relaunch in the same worktree with `--environment <environment id from bb thread show>`; archive a landed worker with `bb thread archive <id>`.
  - Remove the heartbeat everywhere (charter, `restart-note.md`); the restart note says the crew are still its children and still report to it.
  - Status line, titles-never-change, `(hold: …)`, suggestions format, watches' trust rule (§7) unchanged.
  - `board-note.md`: `<firstmate-board>` note — "The captain wrote about {{title}} ({{threadId}}): {{note}}".
  - `relaunch.md`: asks for a fresh worker for {{task}} in environment {{environmentId}}, with the captain's note.
  - `parts/crew-provider-*.md` and `crew-reasoning-*.md`: say to pass `--provider/--model` / `--reasoning` only when the captain asked for something else, since `crew spawn` already applies the setting.
- [ ] **Step 4:** `npm run gen:templates && npx vitest run && npx tsc --noEmit` — PASS.
- [ ] **Step 5:** Commit `firstmate: charter and messages for bb`.

### Task 12: The app

**Files:**
- Create: `app.tsx`, `app/panel.tsx`, `app/board.tsx`, `app/card.tsx`, `app/suggestions.tsx`, `app/watches.tsx`, `app/crew-panel.tsx`, `app/settings-section.tsx`, `app/suggestion-removals.ts` (+ ported test), `app/folds.ts`, `app/folds.test.ts`
- Vendor as needed: `npx shadcn add @bb/button @bb/card @bb/collapsible @bb/textarea @bb/switch @bb/alert-dialog`

**Interfaces:**
- Consumes: `rpcContract` as a type (`import type { rpcContract } from "../server"`), `Fleet`, `FleetCard`, `COLUMN_IDS` from `shared/types`.
- Produces:
  - `app/folds.ts`: `readFolds(storage: Pick<Storage,"getItem">): Set<ColumnId>`, `toggleFold(storage: Storage, column: ColumnId): Set<ColumnId>` (key `firstmate.folds`, JSON array; bad JSON → empty set).
  - `app/suggestion-removals.ts`: Paseo's `suggestionKey`, `RemovalGate`, `createRemovalGate`, `suggestionRemovals`.
  - `app.tsx`: `threadPanelAction({ id: "firstmate", title: "FirstMate", layout: "padded", component: Panel })`; `settingsSection({ component: SettingsSection })`; `commands.register` for "FirstMate: open" (navigate to the first mate's thread and open the tab), "FirstMate: bearings", "FirstMate: ahoy"; `/fm` only if Task 2 found a composer slash API.
  - `Panel({ threadId })`: loads `fleet.load` (re-fetch on `useRealtime` channel `"fleet"`, on reconnect, and every `refreshSeconds` while mounted) and renders `Board` when `threadId === fleet.mate?.threadId`, `CrewPanel` when the thread is one of the cards' crew, else a card: "No first mate aboard" + **Adopt this thread** (→ `mate.adopt`), or "This thread isn't in the crew" + a link to the first mate.
  - `Board`: charter notice (Compare → `charter.compare` then `useBbNavigate().experimental_openFilePreview` of the returned path in the first mate's workspace; Done → `charter.acknowledge`); Bearings/Ahoy buttons (`mate.command`); `Suggestions`; columns in `COLUMN_IDS` order, empty ones hidden, each a collapsible section with its count, fold state via `folds.ts`; `Watches`.
  - `Card`: title, the report text or backlog status, PR link (`UrlLink`), "Captain's call: <hold>", actions Open thread (`toThread`), Steer (textarea → `crew.steer`), Interrupt, Relaunch (textarea → `crew.relaunch`), End (`crew.end`; on `needsConfirmation` an alert dialog: "This worker's task isn't Done. Archiving removes its worktree after bb's grace period; only committed work can be restored." → `crew.end` with `confirmed: true`).
  - `CrewPanel`: the worker's `Card` plus a note textarea → `crew.note`.
  - `SettingsSection`: status line (no first mate / aboard with title and status / gone); `experimental_ProviderModelPicker` + **Launch** (`mate.launch`); **Restart** (confirm; disabled unless idle or error); **Release** (confirm). Errors shown with `toast.error(message)` from `sonner`.
  - `Suggestions`: one button per suggestion (→ `mate.ask` with its prompt, then `toThread(first mate)`), a trash button beside it (sibling, not nested) gated by `suggestionRemovals`; hidden when empty.
  - `Watches`: one row per watch — name (opens the script via `experimental_openFilePreview`), schedule, last run and result, last output (expandable), `outdated`/`failing` badges, a `Switch` → `watch.toggle`.

- [ ] **Step 1:** Port `client/suggestion-removals.ts` and its tests from `client/client.test.ts` into `app/suggestion-removals.test.ts`; write `app/folds.test.ts` (`readFolds` on missing, bad JSON, valid; `toggleFold` adds then removes and persists).
- [ ] **Step 2:** `npx vitest run app/` — FAIL.
- [ ] **Step 3:** Implement `folds.ts`, `suggestion-removals.ts`; `npx vitest run app/` — PASS.
- [ ] **Step 4:** Implement the components and `app.tsx`.
- [ ] **Step 5:** `npx tsc --noEmit && bb plugin build && bb plugin reload firstmate; echo $?` — exit 0 and `0`.
- [ ] **Step 6: Look at it.** Open any thread's right panel → FirstMate: the "No first mate" card. Open Settings → FirstMate: status and picker. Check both in light and dark themes and in a narrow window (compact viewport); no literal colours, nothing clipped. A blank area is a crash — check the browser console.
- [ ] **Step 7:** Commit `firstmate: board, crew panel and settings`.

### Task 13: End-to-end run, docs and collection entry

**Files:**
- Create: `firstmate/AGENTS.md`, `firstmate/README.md`, `firstmate/CHANGELOG.md`, `firstmate/PLUGIN_OVERVIEW.md`, `.bb/plugins.json`
- Modify: root `README.md` (firstmate status), root `AGENTS.md` (wherever the port proved it wrong)

- [ ] **Step 1: End-to-end, against the running bb.** Set the home setting to a scratch path under `$TMPDIR` (not `~/FirstMate`). Launch a first mate from settings with a capable model. Create a scratch git repo with one commit, `bb project create` it, and tell the first mate: "the scratch repo is <path>, ship local-only". Ask for a one-line README change. Expected: `bb thread list --parent-thread <mate>` shows a worker in its own worktree; the board card goes Queued → Working → Idle with `done: ready in branch fm/…`; the first mate relays it. Then Steer the worker once from the card and confirm the first mate hears about it. Press a suggestion if one appears. Restart the first mate while idle and confirm the worker is still its child. Look at the board wide and narrow, light and dark.
- [ ] **Step 2: Clean up** the scratch threads (archive the worker, release and archive the first mate), the scratch project and home, and reset the home setting to its default.
- [ ] **Step 3: Docs.**
  - `firstmate/AGENTS.md`: orientation table of the files above; the invariants from *Global Constraints* and the spec's *Invariants carried over*; why there is no `bb.host` (home and watches on the server's machine); why templates are generated; the watch state location and why not kv; the Paseo parts bb made moot (list from the spec); the result of Task 2's checks.
  - `firstmate/README.md`: what it does, install (`bb plugin install path:/Users/ci/repositories/bb-plugins --plugin firstmate`), getting started, the board, the home's files, watches, settings, limitations (watch notes show in full in chat; watches run only while bb does, on the server's machine; End removes a worktree after bb's grace period).
  - `firstmate/CHANGELOG.md`: `## 0.1.0` for non-technical readers — what a user can observe.
  - `firstmate/PLUGIN_OVERVIEW.md`: under 4000 characters, no leading `#`, no HTML, images or tables.
- [ ] **Step 4:** Create `.bb/plugins.json` with the collection manifest from the root `AGENTS.md` and `{ "name": "firstmate", "source": "./firstmate" }`; update the root README table's firstmate status; fix root `AGENTS.md` where the port found it wrong (at least: plugin code cannot locate its own folder at runtime, so ship data through a generated module; `bb.storage.kv`'s 256 KB limit for queues).
- [ ] **Step 5:** `bb plugin install path:/Users/ci/repositories/bb-plugins --plugin firstmate` is the documented path; verify it with `bb plugin list` → `running` (if it would replace the existing path install, confirm with the user first).
- [ ] **Step 6:** `npx vitest run && npx tsc --noEmit && bb plugin build` — PASS. Commit `firstmate: docs and collection entry`.
- [ ] **Step 7:** Draft the scope comment for issue #6 (what bb made moot, what the thin UI dropped, including the client helpers the issue listed to carry over) and show it to the user; post it with `gh issue comment 6` only after they approve.
