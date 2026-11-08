# Learning Exercises — Orient with a native walkthrough: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Orient to `learning-exercises`: a hidden builder thread writes a per-project orientation
(summary, optionally a walkthrough of chapters, notes and plugin-captured code listings), the plugin
verifies and exports it, and an orientation session runs its two exercises in a new visible thread.

**Architecture:** New pure modules (summary schema, listing verify, Markdown renderer), a new
`OrientationStore` over appended SQLite migrations, an `OrientationService` that owns the hidden builder's
lifecycle and the `orient_*` tools/CLI, a `"spawn"` session mode in `SessionService`, new RPCs, and two app
surfaces (a Learning-tab section and an `orientation` panel tab). Everything from bb stays behind `Ports`.

**Tech Stack:** TypeScript, zod, `@get-bb/plugin-sdk` 0.6.104 (bb 0.48.1), SQLite through
`bb.storage.database()` (better-sqlite3 in tests), vitest + jsdom + Testing Library, React 19.

**Spec:** `docs/superpowers/specs/2026-11-07-learning-exercises-orient-design.md` — read it first; section
numbers below (§n) refer to it.

## Global Constraints

- All work is inside `learning-exercises/`; every command runs from there. Install with
  `npm install --include=dev --cache "$TMPDIR/npm-cache"`.
- `engines` stay `bb >=0.48.1`, `bbPluginSdk >=0.6.104`; the SDK pin stays exactly `0.6.104`.
- Migrations are append-only. The 21 statements shipped in 0.2.0 never change; new ones go after them.
- `shared/*` must not import the SDK root at run time (app bundle rule); `server/*` may.
- Every `ports.send` / spawn input carries a visible line and the agent-only part together (invariant 6).
- The plugin never executes a command; files are read and written only through `bb.sdk.files`.
- Metadata keys: sessions keep `SESSION_METADATA_KEY = "session"`; builders use
  `ORIENTATION_METADATA_KEY = "orientation"`.
- Limits (§5, §6.1), in `ORIENT_LIMITS`: note 8,000 chars; caption 200; listing 200 lines; 60 listings per
  orientation; file ≤ 1,048,576 bytes; purpose 300; languages 1–6; stages 1–10; keyFiles 6–10;
  concepts 3–5; gotchas 2–3; exercises exactly 2; sources 1–40; chapter title 120.
- Timings: builder cap 30 min; verify on tab open at most once per 5 min per orientation; leftover
  sweep retry every 5 min; failed/cancelled rows purged after 7 days.
- Orientation session: `trigger: "orientation"`, `mode: "spawn"`, `maxQuestions` 3; title
  `Orientation: <project name>`; orientation title `Repo Orientation: <project name>`.
- Export default path `ORIENTATION.md`; listings exported as a ```` ```bash ```` block holding
  `sed -n 'A,Bp' <path>` followed by an ```` ```output ```` block with the captured text.
- Changelog copy is for non-technical readers; version becomes `0.3.0`.
- Never test in the user's bb; live checks use a dev bb (root `AGENTS.md`).

## Review Focus

1. **A listed file edited between capture and verify, with lines inserted above the listing** — expected
   *moved* with the new range, not *changed*. Test in Task 2.
2. **A walkthrough note or caption containing triple backticks, and captured code that itself contains a
   fence** — the export must stay well-formed (longer fences). Test in Task 3.
3. **Plugin reload while `threads.spawn` for a builder is in flight** — the old instance's spawn answering
   after the new instance swept must end with that thread archived and the row `failed`, never a second
   live builder. Test in Task 8.
4. **An orientation session started from a thread that already had 2 finished sessions** — must start (the
   orientation session doesn't count toward or against the per-thread cap) and must not consume a slot.
   Test in Task 10.
5. **Export onto an existing `ORIENTATION.md` the user edited after the plugin read it** — refused as
   changed, never overwritten. Test in Task 11.

---

## File structure

| File | Responsibility |
| --- | --- |
| `shared/orientation.ts` (new) | Limits, statuses, `OrientationSummarySchema`, public `Orientation` / `OrientationBlock` schemas, `parseLineRange` |
| `shared/types.ts` (modify) | `"spawn"` mode, `"orientation"` trigger and label |
| `server/orientation-verify.ts` (new) | `sha256`, `sliceLines`, `checkListing` — pure |
| `server/orientation-markdown.ts` (new) | `renderSummaryMarkdown`, `renderOrientationMarkdown` — pure |
| `server/orientation-store.ts` (new) | `OrientationStore` over the new tables |
| `server/store.ts` (modify) | Appended migrations; `finishedSessionsFrom` excludes orientation sessions |
| `server/ports.ts`, `server/bb-ports.ts`, `server/testing/fake-ports.ts` (modify) | Spawn, stop, archive, file read/write, plugin-thread listing |
| `content/orient-builder.md`, `content/orientation-session.md` (new); `server/content.ts` (modify) | Briefs and their builders |
| `server/orientation.ts` (new) | `OrientationService`: start, bind, blocks, finish, cancel, delete, verify, export, lifecycle |
| `server/orientation-tools.ts` (new); `server/cli.ts` (modify) | `orient_*` tools and `bb learning orient …` |
| `server/sessions.ts` (modify) | `startOrientationSession` (`"spawn"` mode) |
| `shared/contract.ts`, `server/api.ts`, `server.ts` (modify) | RPCs, configure, events, sweep |
| `app/orientation-section.tsx` (new), `app/tab.tsx` (modify) | The Learning tab's Orientation section |
| `app/orientation-tab.tsx` (new), `app.tsx` (modify) | The walkthrough panel tab and export dialog |
| `README.md`, `PLUGIN_OVERVIEW.md`, `CHANGELOG.md`, `AGENTS.md`, `NOTICE.md`, `package.json` (modify) | Docs and release |

---

### Task 1: Shared orientation schemas and the new mode and trigger

**Files:**
- Create: `shared/orientation.ts`, `shared/orientation.test.ts`
- Modify: `shared/types.ts:22-31` (`TRIGGER_KINDS`, `TRIGGER_LABELS`), `shared/types.ts:59` (`SessionModeSchema`)

**Interfaces:**
- Produces:
  - `ORIENT_LIMITS` (values in Global Constraints) as a `const` object with keys `noteChars, captionChars,
    listingLines, listings, fileBytes, purposeChars, chapterChars, languages:{min,max}, stages, keyFiles,
    concepts, gotchas, sources` (`{min,max}` pairs) and `exercises: 2`.
  - `ORIENTATION_STATUSES = ["starting","building","ready","failed","cancelled"] as const`, `LIVE_ORIENTATION_STATUSES = ["starting","building"] as const`, `OrientationStatus`.
  - `OrientationDepthSchema = z.enum(["summary","walkthrough"])`, `OrientationDepth`.
  - `OrientationSummarySchema` (§5 fields: `purpose, languages, stages, keyFiles:{path,does,why}[], concepts:{name,definition,where}[], gotchas, exercises:{file,read,question}[], sources`), `OrientationSummary`. Flat, no `.refine` that produces `$ref`.
  - `ListingStateSchema = z.enum(["current","moved","changed","missing"])`, `ListingState`.
  - `OrientationBlockSchema` = discriminated union on `kind`: `{kind:"chapter",ordinal,title}`, `{kind:"note",ordinal,markdown}`, `{kind:"listing",ordinal,number,caption,path,startLine,endLine,text,ref:string|null,check:{state,startLine:number|null,endLine:number|null,checkedAt:number}|null}`.
  - `OrientationSchema` = `{id,status,depth,title,summary:OrientationSummary|null,blocks:number,listings:number,createdAt,updatedAt,readyAt:number|null,error:string|null,headSha:string|null,workspace:Workspace|null}`.
  - `parseLineRange(spec: string): { start: number; end: number } | null` — accepts `"40"` and `"40-72"`, 1-based, `start ≤ end`, else null.
  - `TRIGGER_KINDS` gains `"orientation"` (last); `TRIGGER_LABELS.orientation = "an orientation"`; `SessionModeSchema = z.enum(["fork","here","spawn"])`.

- [ ] **Step 1: Write the failing tests** in `shared/orientation.test.ts`:

```ts
it("accepts a summary at the limits and refuses one exercise or three", () => {
  expect(OrientationSummarySchema.safeParse(summary()).success).toBe(true);
  expect(OrientationSummarySchema.safeParse({ ...summary(), exercises: [summary().exercises[0]] }).success).toBe(false);
  expect(OrientationSummarySchema.safeParse({ ...summary(), exercises: [...summary().exercises, summary().exercises[0]] }).success).toBe(false);
  expect(OrientationSummarySchema.safeParse({ ...summary(), keyFiles: summary().keyFiles.slice(0, 5) }).success).toBe(false);
  expect(OrientationSummarySchema.safeParse({ ...summary(), concepts: [] }).success).toBe(false);
});
it("parses line ranges", () => {
  expect(parseLineRange("40")).toEqual({ start: 40, end: 40 });
  expect(parseLineRange("40-72")).toEqual({ start: 40, end: 72 });
  for (const bad of ["0", "72-40", "a-b", "", "40-", "4.5"]) expect(parseLineRange(bad)).toBeNull();
});
it("has no $ref in the summary's JSON Schema", () => {
  expect(JSON.stringify(z.toJSONSchema(OrientationSummarySchema))).not.toContain("$ref");
});
```

(`summary()` is a local fixture with 6 key files, 3 concepts, 2 gotchas, 2 exercises.)

- [ ] **Step 2: Run** `npx vitest run shared/orientation.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `shared/orientation.ts` (imports `zod` and `WorkspaceSchema` from `./types` only) and the `types.ts` changes.
- [ ] **Step 4: Run** `npx vitest run shared/ && npm run typecheck` — Expected: PASS. Fix every exhaustive `Record<TriggerKind,…>` / `SessionMode` switch the typecheck flags (e.g. `server/content.ts` `startLine`, app labels) with the obvious value.
- [ ] **Step 5: Commit** `git commit -m "learning-exercises: orientation schemas, spawn mode and orientation trigger"`

---

### Task 2: Listing verify (pure)

**Files:**
- Create: `server/orientation-verify.ts`, `server/orientation-verify.test.ts`

**Interfaces:**
- Consumes: `ListingState` (Task 1).
- Produces:
  - `sha256(text: string): string` (hex, `node:crypto`).
  - `sliceLines(text: string, start: number, end: number): string | null` — lines split on `\n` with a trailing `\r` stripped from each; joined with `\n`; null when `end` exceeds the line count.
  - `interface ListingCheck { state: ListingState; startLine: number | null; endLine: number | null }`.
  - `checkListing(fileText: string | null, listing: { startLine: number; endLine: number; text: string; sha256: string }): ListingCheck` — §6.3: null → `missing`; same range hashes equal → `current` with its range; else whole-line search for `listing.text`: one or more hits → `moved` at the hit nearest the old start (ties: earlier); none → `changed` with nulls.

- [ ] **Step 1: Write the failing tests:**

```ts
const file = ["a", "b", "c", "d", "e"].join("\n");
const listing = { startLine: 2, endLine: 3, text: "b\nc", sha256: sha256("b\nc") };
it("is current when the range still holds the text", () => expect(checkListing(file, listing)).toEqual({ state: "current", startLine: 2, endLine: 3 }));
it("is moved when lines were inserted above", () => expect(checkListing(`x\ny\n${file}`, listing)).toEqual({ state: "moved", startLine: 4, endLine: 5 }));
it("picks the hit nearest the old start", () => expect(checkListing("b\nc\nz\nz\nz\nb\nc", { ...listing, startLine: 6, endLine: 7 }).startLine).toBe(6));
it("is changed when the text is gone", () => expect(checkListing("a\nB\nc", listing)).toEqual({ state: "changed", startLine: null, endLine: null }));
it("is missing when the file cannot be read", () => expect(checkListing(null, listing).state).toBe("missing"));
it("is changed, not thrown, when the file shrank below the range", () => expect(checkListing("a", listing).state).toBe("changed"));
it("treats CRLF files as their LF text", () => expect(checkListing(file.replace(/\n/g, "\r\n"), listing).state).toBe("current"));
it("does not match a partial line", () => expect(checkListing("ab\nc", { ...listing, startLine: 1, endLine: 2 }).state).toBe("changed"));
```

- [ ] **Step 2: Run** `npx vitest run server/orientation-verify.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the three functions.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "learning-exercises: verify an orientation listing against its file"`

---

### Task 3: Markdown renderer (pure)

**Files:**
- Create: `server/orientation-markdown.ts`, `server/orientation-markdown.test.ts`, `server/testing/showboat-grammar.ts`

**Interfaces:**
- Consumes: `OrientationSummary`, `OrientationBlock` (Task 1).
- Produces:
  - `renderSummaryMarkdown(summary: OrientationSummary): string` — the sections of §8 from `## One-line purpose` through `## Sources consulted`, in that order (key files as ``- `path` — does | why``; concepts as `**name**: definition (where)`; exercises numbered with "Open `file`. Read: … Then: …").
  - `renderOrientationMarkdown(doc: { title: string; readyAt: number; headSha: string | null; summary: OrientationSummary; blocks: readonly OrientationBlock[] }): string` — §8 exactly: H1, `*<ISO readyAt>*` with ` · built at \`<7-char sha>\`` when known, the generated-by quote, the summary, then (when blocks exist) `## Contents` (one bullet per chapter, linking `#` slugs), chapters with their notes, `## Code Listings`, each listing as `### Listing N: caption`, `<a id="listing-N"></a>`, the `bash` `sed -n 'A,Bp' 'path'` block and the `output` block. Fences use one more backtick than the longest backtick run inside, minimum 3. Paths in `sed` are single-quoted with `'` escaped as `'\''`.
  - `server/testing/showboat-grammar.ts`: `parseShowboat(markdown: string): Array<{ type: "commentary" } | { type: "code"; lang: string; code: string } | { type: "output"; content: string }>` — a test-only port of showboat's `markdown/parser.go` block rules (fenced blocks with any fence length ≥ 3; `output` lang = output block; everything else commentary).

- [ ] **Step 1: Write the failing tests:** a golden-file test (`server/testing/orientation.golden.md`, written from the renderer once and reviewed by hand against §8); and:

```ts
it("exports every listing as a code block followed by its output", () => {
  const blocks = parseShowboat(renderOrientationMarkdown(doc));
  const code = blocks.filter((b) => b.type === "code");
  expect(code.map((b) => b.code)).toEqual(["sed -n '40,72p' 'src/retry.ts'"]);
  expect(blocks[blocks.indexOf(code[0]) + 1]).toEqual({ type: "output", content: listingText });
});
it("lengthens fences around text that contains fences", () => {
  const md = renderOrientationMarkdown({ ...doc, blocks: [chapter, listingWith("```js\nx\n```")] });
  expect(parseShowboat(md).find((b) => b.type === "output")).toEqual({ type: "output", content: "```js\nx\n```" });
});
it("leaves out Contents and Code Listings for a summary-only orientation", () => {
  expect(renderOrientationMarkdown({ ...doc, blocks: [] })).not.toContain("## Code Listings");
});
it("quotes a path with a single quote safely", () => expect(renderOrientationMarkdown(withPath("it's.ts"))).toContain(`'it'\\''s.ts'`));
```

- [ ] **Step 2: Run** `npx vitest run server/orientation-markdown.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the renderer and the test grammar.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "learning-exercises: render an orientation as showboat-compatible Markdown"`

---

### Task 4: Storage

**Files:**
- Create: `server/orientation-store.ts`, `server/orientation-store.test.ts`
- Modify: `server/store.ts:33-127` (append migrations), `server/store.ts:490-492` (`finishedSessionsFrom`), `server/migration.test.ts`, `server/testing/store.ts` (expose an `OrientationStore` on the same db)

**Interfaces:**
- Consumes: Task 1 types.
- Produces (in `orientation-store.ts`):
  - `interface OrientationRow { id; projectKey; projectId; status: OrientationStatus; depth: OrientationDepth; sourceThreadId; environmentId: string | null; hostId: string | null; workspacePath: string | null; providerId; builderThreadId: string | null; headSha: string | null; title; summary: OrientationSummary | null; reminded: boolean; error: string | null; createdAt; updatedAt; readyAt: number | null }`
  - `interface BlockRow` = `OrientationBlock` plus `orientationId` and, for listings, `sha256: string`.
  - `class OrientationStore { constructor(db) ; create(input: Omit<OrientationRow,"status"|"builderThreadId"|"summary"|"reminded"|"error"|"updatedAt"|"readyAt">): OrientationRow /* status starting; throws on the unique index */; get(id): OrientationRow | null; live(projectKey): OrientationRow | null; ready(projectKey): OrientationRow | null; byBuilder(threadId): OrientationRow | null; allLive(): OrientationRow[]; bindBuilder(id, threadId, now): boolean /* only when null */; transition(id, from: readonly OrientationStatus[], to: OrientationStatus, now, error?: string | null): boolean; setSummary(id, summary, now): void; markReminded(id, now): boolean /* false if already */; appendChapter(id, title, now): BlockRow; appendNote(id, markdown, now): BlockRow; appendListing(id, l: { caption; path; startLine; endLine; text; sha256; ref: string | null }, now): BlockRow; pop(id, now): BlockRow | null; blocks(id): BlockRow[]; counts(id): { blocks: number; listings: number }; setCheck(id, ordinal, check: ListingCheck, now): void; promoteReady(id, now): void /* status→ready, readyAt, and deletes older ready rows of the project + their blocks, one transaction */; delete(id): void; purge(before: number): number /* failed/cancelled older than */ }`
- Migrations appended to `MIGRATIONS` (§4 tables; `orientation_blocks` PK `(orientation_id, ordinal)`; `CREATE UNIQUE INDEX orientations_one_live_per_project ON orientations(project_key) WHERE status IN ('starting','building')`; `CREATE INDEX orientations_builder ON orientations(builder_thread_id)`). `listing_no` is `MAX(listing_no)+1` over all blocks ever appended, kept in `orientations.next_listing` so a pop never frees a number.
- `finishedSessionsFrom` SQL gains `AND trigger <> 'orientation'`.

- [ ] **Step 1: Write the failing tests:** in `migration.test.ts`, pin the 0.2.0 prefix:

```ts
it("keeps 0.2.0's 21 statements unchanged", () => {
  expect(MIGRATIONS.slice(0, 21).map(sha)).toEqual(V0_2_0_HASHES); // the 21 hashes computed from `git show e030f11:learning-exercises/server/store.ts`
});
```

and in `orientation-store.test.ts`: create refuses a second live row for a project and allows one after `transition(…, "failed")`; `bindBuilder` binds once; `transition` from the wrong status returns false and changes nothing; listing numbers go 1, 2, then after `pop` the next is 3; `promoteReady` leaves exactly one ready row per project and deletes the old one's blocks; `purge` removes only failed/cancelled rows older than the cutoff; and in `store`'s tests, `finishedSessionsFrom` ignores a finished session whose trigger is `orientation`.

- [ ] **Step 2: Run** `npx vitest run server/orientation-store.test.ts server/migration.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the migrations, `OrientationStore` (prepared statements, JSON for `summary`), and the `finishedSessionsFrom` change.
- [ ] **Step 4: Run** `npx vitest run server/` — Expected: PASS (all existing store tests too).
- [ ] **Step 5: Commit** `git commit -m "learning-exercises: store orientations and their blocks"`

---

### Task 5: Ports for spawning, stopping, archiving and files

**Files:**
- Modify: `server/ports.ts`, `server/bb-ports.ts`, `server/testing/fake-ports.ts`
- Test: `server/bb-ports.test.ts` (new; over `createFakePluginHost` stubs)

**Interfaces:**
- Produces (added to `Ports`):
  - `interface SpawnRequest { projectId: string; environmentId: string; providerId: string; title: string; hidden: boolean; visible: string; agentOnly: string; metadata: Record<string, string> }`
  - `spawn(request: SpawnRequest): Promise<{ threadId: string }>` — `threads.spawn({ projectId, title, visibility: hidden ? "hidden" : "visible", environment: { type: "reuse", environmentId }, providerId, input: [{type:"text",text:visible,mentions:[]},{type:"text",text:agentOnly,visibility:"agent-only",mentions:[]}], pluginMetadata: metadata })`; throws on failure.
  - `stopThread(threadId): Promise<void>`, `archiveThread(threadId): Promise<void>` — throw on failure.
  - `interface FileRoot { hostId: string; rootPath: string }`; `environmentRoot(environmentId): Promise<FileRoot | null>` (from `environments.get`: `hostId`, `path`; null when no path).
  - `projectCheckout(projectId, hostId): Promise<string | null>` (`projects.get` → the source on that host).
  - `type FileRead = { kind: "text"; text: string; sha256: string; sizeBytes: number } | { kind: "missing" } | { kind: "binary" } | { kind: "too-large" }`; `readFile(root: FileRoot, relativePath: string): Promise<FileRead | null>` — null when the host/read fails for another reason; `too-large` above `ORIENT_LIMITS.fileBytes` (check `sizeBytes`); `binary` when the content is not valid UTF-8 or holds a NUL; `missing` on a not-found error.
  - `writeFile(root: FileRoot, relativePath: string, content: string, expectedSha256: string | null): Promise<void>` — `files.write({ …, contentEncoding: "utf8", createParents: true, expectedSha256 })`; throws `FileConflict` (exported class) when bb answers a hash mismatch, any other error as is.
  - `pluginThreadsWith(metadataKey: string): Promise<{ threadId: string; value: string; archived: boolean; status: string }[] | null>` — `threads.list({ originPluginId: PLUGIN_ID, limit: 200 })` then `experimental_listPluginMetadata`; null when either read fails.
  - `metadataValue(threadId, key): Promise<string | null>` (generalizes `sessionIdOf`, which now calls it).
- `FakePorts` gains: `spawned: SpawnRequest[]`, `spawnFails`, `duringSpawn: ((threadId) => Promise<void>) | null`, `stopped: string[]`, `archived: string[]`, `archiveFails`, `files: Map<string, string>` (key `${rootPath}/${path}`), `writes`, `pluginThreadsUnreadable`, plus implementations.
- Path safety lives in the service (Task 7) through the existing `workspacePath`; ports receive normalized relative paths.

- [ ] **Step 1: Write the failing tests** in `server/bb-ports.test.ts`: `spawn` sends both input parts with the agent-only one marked and `visibility: "hidden"`; `readFile` maps a stubbed not-found error to `missing`, `sizeBytes` over the limit to `too-large`, a NUL to `binary`; `writeFile` passes `expectedSha256: null` for a new file and throws `FileConflict` on bb's mismatch error; `pluginThreadsWith` returns null when `threads.list` throws.
- [ ] **Step 2: Run** `npx vitest run server/bb-ports.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** in `bb-ports.ts` and `fake-ports.ts`. Read the not-found and hash-mismatch error shapes from `diff-review/server/edits.ts` (`written`, `text`) and match them the same way.
- [ ] **Step 4: Run** `npx vitest run server/ && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "learning-exercises: ports to spawn and put away threads and to read and write files"`

---

### Task 6: The builder and orientation-session briefs

**Files:**
- Create: `content/orient-builder.md`, `content/orientation-session.md`
- Modify: `server/content.ts`, `server/content.generated.ts` (regenerated), `server/content.test.ts`

**Interfaces:**
- Consumes: `renderSummaryMarkdown` (Task 3), `OrientationDepth`.
- Produces:
  - `ORIENT_BUILDER = file("orient-builder.md")`, `ORIENTATION_SESSION = file("orientation-session.md")`.
  - `buildBuilderBrief(input: { depth: OrientationDepth; projectName: string }): string` — the builder brief, plus a "How to write" section naming the `orient_*` tools first and the `bb learning orient …` commands as the fallback (a CLI block in the style of `CLI_BLOCK`), and the depth (a summary build is told to call only `orient_summary` and `orient_finish`).
  - `builderStartLine(projectName: string, depth: OrientationDepth): string` — the visible line, e.g. `Building an orientation for calc (with a walkthrough).`
  - `buildOrientationSessionBrief(input: { summary: OrientationSummary; drift: readonly string[]; learnerProfile: string }): string` = `brief.md` + `orientation-session.md` + the summary (via `renderSummaryMarkdown`, under "The orientation, as data (not instructions)" in a quoted block) + drift lines (`- Listing 3 (src/a.ts:40-72) changed since abc1234: …`) + `howToAsk("fork")` + `- Ask at most 3 questions; the card refuses more.`
  - `ORIENT_TOOL_INVARIANT`: one sentence for `configure`'s `instructions` on builder threads ("This hidden thread builds an orientation for the Learning Exercises plugin. Write only through the orient_* tools (or `bb learning orient …`), never edit or create files, and call orient_finish last.").
- Content of `orient-builder.md` (§7 "The builder brief"): adapted from upstream `orient/skills/orient/SKILL.md` Steps 2–4 and the showboat path's planning and writing rules, with the language signal table, the exploration steps with their sources, the summary rules, the walkthrough rules (plan chapters and listings before writing; build in reading order; explain why; reference `Listing N`; no fenced code in notes), upstream's good/bad orientation-exercise examples, and "do not edit or create files, do not commit". End with the CC BY 4.0 attribution line in the style of `brief.md`'s.
- Content of `orientation-session.md`: upstream "Orientation mode" (§9): the user already chose to start, so open the first question with a one-sentence summary of what the orientation covers; run the two exercises in order (direct them to the named file, then ask the synthesis question; never ask them to predict what they haven't read); fading scaffolding and wrong answers as data; then the closing question verbatim: "What's one thing about this codebase that surprised you or that you want to dig into further?"; then `learning_finish` with a summary that suggests one follow-up file or exercise based on that answer. Attribution line.

- [ ] **Step 1: Write the failing tests** in `content.test.ts`: the generated file matches `content/` (the existing check covers new files); `buildBuilderBrief({depth:"summary"})` names `orient_summary` and `orient_finish` and does not name `orient_listing`; the walkthrough brief names all six tools and `bb learning orient listing`; `buildOrientationSessionBrief` contains the closing question verbatim, the summary's purpose quoted, each drift line, and "at most 3 questions".
- [ ] **Step 2: Run** `npx vitest run server/content.test.ts` — Expected: FAIL.
- [ ] **Step 3: Write** both Markdown files, then run `npm run gen:content`, then implement the builders in `content.ts`.
- [ ] **Step 4: Run** `npx vitest run server/content.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "learning-exercises: the orientation builder and session briefs"`

---

### Task 7: OrientationService — start, blocks, finish, cancel, delete, verify, export

**Files:**
- Create: `server/orientation.ts`, `server/orientation.test.ts`

**Interfaces:**
- Consumes: `OrientationStore` (4), `Ports` additions (5), briefs (6), `checkListing`/`sliceLines`/`sha256` (2), `renderOrientationMarkdown` (3), `projectKey`/`canStartByHand` (`policy.ts`), `workspacePath` (today `app/file-refs.tsx:73`; move it unchanged to `shared/workspace-path.ts`, re-export it from `app/file-refs.tsx`, and import it on the server from there).
- Produces:
  - `export const ORIENTATION_METADATA_KEY = "orientation"`; `export class OrientationError extends Error {}`.
  - `class OrientationService { constructor(ports: Ports, store: OrientationStore, settings: () => LearningSettings)`
    - `start(input: { sourceThreadId: string; depth: OrientationDepth }): Promise<{ orientationId: string }>` — under `exclusive("orient:"+projectKey)`: refuses with `OrientationError` when `!this.clean` ("Cleaning up an earlier build; try again shortly."), when `canStartByHand(source)` is false, when the thread has no environment, or when a live row exists ("An orientation is already being built for this project."); reserves (`create`), then `ports.spawn({ hidden: true, metadata: { [ORIENTATION_METADATA_KEY]: id }, visible: builderStartLine(...), agentOnly: buildBuilderBrief(...) , title: "Orientation builder: <project>", … })`; on success `bindBuilder` and `transition(["starting"],"building")`; on failure `transition(["starting"],"failed", now, message)` and rethrow as `OrientationError`.
    - `builderFor(threadId: string): Promise<OrientationRow>` — the bound live row, or binds a `starting`/`building` row with null builder whose id `ports.metadataValue(threadId, ORIENTATION_METADATA_KEY)` names **and** whose thread `ports.thread(threadId).originPluginId === PLUGIN_ID`; else `OrientationError("This thread is not building an orientation.")`.
    - `chapter(threadId, title)`, `note(threadId, markdown)`, `listing(threadId, { path, lines, caption })`, `pop(threadId)`, `summary(threadId, value: unknown)`, `finish(threadId)` — each `Promise<string>` (the text the agent reads back), each under `exclusive("orientation:"+id)`, each refusing in a summary-depth build where §6.1 says so, each calling `ports.changed()` after a write.
      - `note` refuses a fenced code block (``/^\s{0,3}(`{3,}|~{3,})/m``) and text over the limit.
      - `listing` normalizes `path` with `workspacePath` (refuses null: "That path is outside the workspace."), `parseLineRange` (refuses null), the 200-line and 60-listing limits, reads with `ports.readFile(root, path)` (root from `environmentRoot(row.environmentId)`) and maps `missing`/`binary`/`too-large`/null to refusals naming the path; `sliceLines` null → "`path` has only N lines."; stores text, `sha256`, `ref: row.headSha`; returns `Listing N captured (path:A-B):\n\n<fenced text>`.
      - `summary` parses with `OrientationSummarySchema` and refuses with zod's issues joined, one per line.
      - `finish` refuses a missing summary; for a walkthrough, no chapter, or listings never referenced as `Listing N` in a note (names them); otherwise runs `verifyRows`, `promoteReady`, then `putAway(builderThreadId)`; returns "The orientation is ready."
    - `cancel(orientationId): Promise<void>` — `transition(["starting","building"],"cancelled", now, "Cancelled.")` then `putAway`.
    - `delete(orientationId): void` — refuses a live row.
    - `verify(orientationId, opts?: { ifOlderThanMs?: number }): Promise<{ checked: number; drift: string[] }>` — reads each listing's file once per path, `checkListing`, `setCheck`; root from `environmentRoot`, else `projectCheckout(projectId, hostId)`; with neither, changes nothing and returns `drift: []` with `checked: 0`; skips when every listing's `checkedAt` is newer than `ifOlderThanMs`. Drift lines for `moved`/`changed`/`missing`.
    - `export(orientationId, input: { path: string; replace: boolean }): Promise<{ exists: true } | { written: string }>` — normalizes the path (refuse outside workspace), renders, reads the current file: exists and `!replace` → `{ exists: true }`; else `writeFile(root, path, md, current?.sha256 ?? null)`; `FileConflict` → `OrientationError("<path> changed while you were deciding; export again.")`.
    - `view(projectKey): { current: OrientationRow | null; live: OrientationRow | null }` and `document(orientationId): { row: OrientationRow; blocks: BlockRow[] } | null` for the API.
    - private `putAway(threadId: string | null): Promise<void>` — `stopThread` in `try`, `archiveThread` in `finally`, both errors to `ports.warn`, never thrown.
  - Every continuation after an await calls `this.alive()` (throws `OrientationError` when disposed), as `SessionService` does.

- [ ] **Step 1: Write the failing tests** in `server/orientation.test.ts` over `FakePorts` + an in-memory store (follow `sessions.test.ts`'s setup):
  - start spawns one hidden thread with the metadata key and both input parts; a second start for the project is refused; a spawn failure leaves the row `failed` with the message and allows a new start.
  - a tool call from an unbound thread binds only when its metadata names the row and its `originPluginId` is `learning-exercises`; a thread with matching metadata but another origin is refused.
  - listing refusals: `../x.ts`, `/etc/passwd`, `src/a.ts:0`, 201 lines, the 61st listing, a missing file, a binary file; a good listing returns the captured text and stores the hash and the build's HEAD.
  - note with a ```` ``` ```` fence is refused; a summary-depth build refuses chapter/note/listing.
  - finish: refused without summary; refused for a walkthrough whose `Listing 2` is never mentioned (names "Listing 2"); succeeds otherwise, marks `ready`, deletes the previous ready orientation, and `stopped`/`archived` contain the builder.
  - cancel stops and archives; an archive failure only warns.
  - verify after editing a fake file above a listing reports `moved`; with `ifOlderThanMs` inside the window it reads nothing; with the environment gone it reads the project checkout.
  - export: new file written with `expectedSha256: null`; existing file and `replace: false` → `{ exists: true }`; `replace: true` writes with the read hash; a hash change between read and write (fake throws `FileConflict`) → the "changed while you were deciding" error (Review Focus 5).
- [ ] **Step 2: Run** `npx vitest run server/orientation.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `OrientationService` (copy `exclusive` and `alive` from `SessionService`; do not share a base class).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "learning-exercises: build, finish, verify and export orientations"`

---

### Task 8: OrientationService — the builder's lifecycle and reload safety

**Files:**
- Modify: `server/orientation.ts`
- Test: `server/orientation-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 7.
- Produces (on `OrientationService`):
  - `get clean(): boolean`.
  - `reconcile(): Promise<void>` — run once at load and by `sweep`. For each `allLive()` row: builder bound and `ports.thread` says not archived and status running/idle-with-turn → keep; else `transition(…, "failed", now, "Interrupted by a reload.")` and `putAway`. Then `pluginThreadsWith(ORIENTATION_METADATA_KEY)`: archive each non-archived thread whose value is not a live row's id (a `starting` row with null builder whose id matches gets bound instead). `clean = true` only if every read and archive succeeded; on any failure `clean = false` and `ports.warn`.
  - `onIdle(threadId): Promise<void>` — for a `building` row whose builder is `threadId`: first time (`markReminded` true) `ports.send(threadId, "Reminder: finish the orientation.", "<agent-only: call orient_finish, or fix what it refused>")`; second time `transition(["building"],"failed", now, "The builder stopped before finishing.")` and `putAway`.
  - `onFailed(threadId): Promise<void>` — `failed` ("The builder's turn failed.") and `putAway`.
  - `sweep(): Promise<void>` — cancel live rows older than 30 min ("Took longer than 30 minutes."), `purge(now - 7 days)`, then `reconcile()` when `!clean`. It runs every 5 minutes (Task 11), not hourly as §7 first said, so the 30-minute cap and the clean-up retry share one schedule; record that in `AGENTS.md` (Task 14).
  - `isBuilderThread(threadId): boolean` — `store.byBuilder(threadId) !== null`.
  - `dispose(): void` — sets disposed; nothing awaited after it writes.
- During `start`, a spawn that answers after `dispose()` must not write: the new instance's `reconcile` archives that thread (found by metadata) and fails the row.

- [ ] **Step 1: Write the failing tests:**
  - first idle sends exactly one reminder with a visible line and the agent-only part; second idle fails, stops and archives; an idle on a `ready` row does nothing.
  - `onFailed` fails and archives.
  - `sweep` at +31 min cancels and archives; at +29 min does nothing; purges a failed row 8 days old, keeps one 6 days old.
  - **reload with a spawn in flight (Review Focus 3):** instance A starts; `duringSpawn` disposes A and loads instance B over the same store and fake, whose `reconcile` runs while the spawn is unanswered; when the spawn answers, A writes nothing; B's next `reconcile` (via `sweep`) finds the thread by metadata and either binds it (row still `starting`) or archives it (row `failed`) — assert the end state is one row `failed` *or* `building`, never two live, and no thread left unarchived without a live row.
  - with `pluginThreadsUnreadable`, `clean` is false and `start` is refused with the cleaning-up message; after it becomes readable, `sweep` sets `clean` and `start` works.
  - with `archiveFails`, `clean` stays false.
  - dispose during each await of `start`, `listing`, `finish`, `verify` and `reconcile` leaves the store unchanged after the await and produces no unhandled rejection (vitest fails on unhandled rejections; assert with `process.on("unhandledRejection")` counter staying 0).
- [ ] **Step 2: Run** `npx vitest run server/orientation-lifecycle.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run server/` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "learning-exercises: keep orientation builders bounded across turns, failures and reloads"`

---

### Task 9: The `orient_*` tools and `bb learning orient …`

**Files:**
- Create: `server/orientation-tools.ts`, `server/orientation-tools.test.ts`
- Modify: `server/cli.ts`, `server/cli.test.ts`

**Interfaces:**
- Consumes: `OrientationService` (7), `OrientationSummarySchema`, `ORIENT_LIMITS`.
- Produces:
  - `ORIENT_TOOL_NAMES = ["orient_chapter","orient_note","orient_listing","orient_pop","orient_summary","orient_finish"] as const`.
  - `registerOrientationTools(bb: BbPluginApi, orientations: OrientationService): void` — six `bb.agents.registerTool` calls in `tools.ts`'s style (`guarded` mapping `OrientationError` to `isError` results; `presentation` labels like "Adding a listing" / "Added a listing", glyph `"Brain"`; `orient_summary`'s parameters are `OrientationSummarySchema`).
  - CLI: `bb learning orient chapter --title-base64-stdin`, `note --markdown-base64-stdin`, `listing --path P --lines A-B --caption-base64-stdin`, `pop`, `summary --summary-base64 <b64 JSON>`, `finish`, each calling the service with `ctx.threadId` (refusing a missing thread id like the existing commands). Reuse `decodeBase64Text` with byte caps: title 1,000, markdown 8,000, caption 1,000, summary JSON 32,000.

- [ ] **Step 1: Write the failing tests:** each tool's JSON Schema has no `$ref`; `orient_listing` executed from a non-builder thread returns `isError` with "not building an orientation"; the CLI's `orient listing` with a bad `--lines` exits with the service's refusal text; `orient summary` with invalid base64 fails with `invalid_value`.
- [ ] **Step 2: Run** `npx vitest run server/orientation-tools.test.ts server/cli.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "learning-exercises: orient tools and CLI for the builder"`

---

### Task 10: The orientation session (`"spawn"` mode)

**Files:**
- Modify: `server/sessions.ts`, `server/sessions.test.ts`

**Interfaces:**
- Consumes: `ports.spawn` (5), `buildOrientationSessionBrief` (6), `OrientationService.verify` and `document` (7).
- Produces:
  - `SessionService.startOrientationSession(input: { sourceThreadId: string; orientationId: string; summary: OrientationSummary; drift: readonly string[]; projectName: string }): Promise<{ sessionId: string; threadId: string }>` — under the same `start:<sourceThreadId>` lock and the same one-open-session check as `startLocked`; `createSession({ mode: "spawn", trigger: "orientation", topic: "Orientation: <projectName>", refs: { paths: summary.exercises.map((e) => e.file) }, … })`; `ports.spawn({ hidden: false, title: "Orientation: <projectName>", metadata: { [SESSION_METADATA_KEY]: sessionId }, visible: startLine(topic, "orientation", refs), agentOnly: buildOrientationSessionBrief(...) })`; binds the thread (`bindSessionThread`), `transition(["starting"],"active")`. On spawn failure delete the session and throw `SessionError("Could not start the session: …")`.
  - `export const ORIENTATION_MAX_QUESTIONS = 3` and a private `questionLimit(session: SessionRow): number` = `session.trigger === "orientation" ? ORIENTATION_MAX_QUESTIONS : this.settings().questionsPerSession`, replacing the three direct reads of `this.settings().questionsPerSession` in `sessions.ts` (`ask` ≈ line 286, `feedback` ≈ line 485, `resumeLocked` ≈ line 580). No new column.
  - `sessionIn` also binds an unbound `spawn` session whose id the thread's metadata names (as for `fork`).
  - Everything else (`ask`, `feedback`, `finishFromAgent`, pause/resume) treats `spawn` like `fork`. Resume of a `spawn` session whose thread is archived unarchives it, as for `fork`.

- [ ] **Step 1: Write the failing tests:**
  - starts a visible spawned thread with the session metadata, the brief agent-only and the visible start line; the session is `active`, mode `spawn`, trigger `orientation`.
  - the 4th `learning_ask` in that session is refused (limit 3).
  - **Review Focus 4:** a source thread with 2 finished sessions (the cap) can still start an orientation session, and after it finishes `finishedSessionsFrom` still reports 2.
  - a second orientation session while one is open from the same source thread is refused with the existing message.
  - spawn failure leaves no session row.
- [ ] **Step 2: Run** `npx vitest run server/sessions.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run server/` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "learning-exercises: orientation sessions in their own thread"`

---

### Task 11: RPCs, configure and server wiring

**Files:**
- Modify: `shared/contract.ts`, `server/api.ts`, `server.ts`, `server.test.ts`

**Interfaces:**
- Consumes: Tasks 7–10.
- Produces (contract, every read with `tags`):
  - `orientation: { input: ThreadRef, output: z.object({ current: OrientationSchema.nullable(), live: OrientationSchema.nullable(), canStart: z.boolean(), cleaning: z.boolean() }) }`
  - `orientationDocument: { input: z.object({ orientationId }), output: z.object({ orientation: OrientationSchema, blocks: z.array(OrientationBlockSchema) }) }` — the handler calls `verify(id, { ifOlderThanMs: 5 * MINUTE })` first.
  - `startOrientation: { input: ThreadRef.extend({ depth: OrientationDepthSchema }), output: z.object({ orientationId: z.string() }) }`
  - `cancelOrientation`, `deleteOrientation`: `{ input: { orientationId }, output: Done }`
  - `verifyOrientation: { input: { orientationId }, output: z.object({ checked: z.number(), drift: z.array(z.string()) }) }`
  - `exportOrientation: { input: { orientationId, path: z.string().trim().min(1).max(500), replace: z.boolean() }, output: z.union([z.object({ exists: z.literal(true) }), z.object({ written: z.string() })]) }`
  - `startOrientationSession: { input: ThreadRef.extend({ orientationId }), output: z.object({ threadId: z.string() }) }` — verifies, then `sessions.startOrientationSession` with the drift lines.
  - All mutations wrapped in `fromUser`. `OrientationError` and `SessionError` become `experimental_PluginRpcRefusal` the way existing handlers surface `SessionError` (follow `api.ts`).
- `server.ts`:
  - construct `OrientationStore(db)` and `OrientationService(ports, orientationStore, settings)`; `bb.onDispose(() => orientations.dispose())`; `void guard("Cleaning up orientation builders", () => orientations.reconcile())()` at load.
  - `registerOrientationTools(bb, orientations)`; the CLI factory takes `orientations` too.
  - `configure`: keep the session branch, extended to `session.mode === "fork" || session.mode === "spawn"` and, for an unbound `spawn` session, accept when the metadata id names a `starting` session (spawn's configure may run before `spawn` answers). Add a builder branch: metadata `ORIENTATION_METADATA_KEY` names a row that is `starting`/`building` and (`builderThreadId === context.thread.id` or `builderThreadId === null && status === "starting"`) → `{ tools: [...ORIENT_TOOL_NAMES], skills: [], instructions: ORIENT_TOOL_INVARIANT }`. Everything else `{ tools: [], skills: [] }`.
  - events: `thread.active` / `thread.idle` / `thread.failed` return early for `orientations.isBuilderThread(id)` before the offer engine; `thread.idle` and `thread.failed` then call `orientations.onIdle` / `onFailed`.
  - a second schedule `bb.background.schedule("orientation-sweep", "*/5 * * * *", guard("The orientation sweep", () => orientations.sweep()))`.

- [ ] **Step 1: Write the failing tests** in `server.test.ts` (extend `setup()` with stubs for `threads.spawn`, `threads.stop`, `threads.archive`, `threads.list`, `threads.experimental_listPluginMetadata`, `files.read`, `files.write`):
  - `configure` for the work thread, a builder thread whose metadata names an unknown id, and a builder thread whose row is `ready` all return `{ tools: [], skills: [] }`; the bound builder gets exactly `ORIENT_TOOL_NAMES`; a bound `spawn` session thread gets `TOOL_NAMES`.
  - round trip: `startOrientation` (walkthrough) → builder calls `orient_chapter`, `orient_note` ("see Listing 1"), `orient_listing` (`src/median.ts`, `1-3`), `orient_summary`, `orient_finish` through `harness` tool execution → `orientation` read shows `current` with `status: "ready"` and the builder archived → `startOrientationSession` spawns a visible thread → its `learning_ask` opens a card.
  - a builder thread's `thread.idle` produces no offer and one reminder.
  - `exportOrientation` called by another plugin (`experimental_caller.kind === "plugin"`) is refused.
  - the existing zero-context test still passes (no `skills/` folder, no `contributeInstructions`).
- [ ] **Step 2: Run** `npx vitest run server.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "learning-exercises: orientation RPCs, configure and events"`

---

### Task 12: The Learning tab's Orientation section

**Files:**
- Create: `app/orientation-section.tsx`, `app/orientation-section.test.tsx`
- Modify: `app/tab.tsx` (render `<OrientationSection threadId visible />` between `Now`/`Start` and `Lists` in `LearningTab`)

**Interfaces:**
- Consumes: contract RPCs `orientation`, `startOrientation`, `cancelOrientation`, `deleteOrientation`, `verifyOrientation`, `startOrientationSession` (types only from `../shared/contract`); `FileMarkdown`/`TextWithFileRefs` from `app/file-refs.tsx`; `useAct` pattern and `Section` from `tab.tsx` (export them).
- Produces: `OrientationSection(props: { threadId: string; visible: boolean })` with these states (§3), each control named exactly so tests can find it by role and name:
  - none: button **Orient me to this project**, checkbox **Include a walkthrough**, the permission line ("A background agent reads this project for a few minutes in this checkout. bb gives it permission to read and edit files; it is told not to edit anything.").
  - cleaning: the message from `cleaning: true` and the start button disabled.
  - live: `Building · N blocks · M min` and button **Cancel**.
  - ready: summary (purpose, languages, stages, key files as links, concepts, gotchas, collapsed by default except purpose), buttons **Start orientation session**, **Read walkthrough** (only when `listings > 0` or `blocks > 0`), **Verify**, **Export to repo…**, **Rebuild**, **Delete**. Rebuild while ready shows the live state *and* keeps the summary.
  - failed/cancelled (newest live-or-recent row is failed): its `error` and **Rebuild**.
  - **Read walkthrough** calls `useAppPanel().openTab({ tab: { id: ORIENTATION_TAB_ID, context: { kind: "thread" }, availability: "action" }, params: { orientationId } })` (`ORIENTATION_TAB_ID` from Task 13). **Export to repo…** opens the export dialog from Task 13 inline.
  - **Start orientation session** navigates to the returned thread (`useBbNavigate().toThread`).

- [ ] **Step 1: Write the failing tests** (jsdom, follow `app/app.test.tsx`'s RPC stubbing): each state renders its named controls; checking **Include a walkthrough** then **Orient me to this project** calls `startOrientation` with `depth: "walkthrough"`; **Cancel** calls `cancelOrientation`; a key file renders as a link; in the cleaning state the start button is disabled.
- [ ] **Step 2: Run** `npx vitest run app/orientation-section.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement.** Use semantic Tailwind classes only (`text-muted-foreground`, `border-border`, `text-warning-text`).
- [ ] **Step 4: Run** `npx vitest run app/ && npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "learning-exercises: the Learning tab's Orientation section"`

---

### Task 13: The walkthrough panel tab and the export dialog

**Files:**
- Create: `app/orientation-tab.tsx`, `app/export-dialog.tsx`, `app/orientation-tab.test.tsx`
- Modify: `app.tsx` (register the tab)

**Interfaces:**
- Consumes: `orientationDocument`, `verifyOrientation`, `exportOrientation`; `experimental_FileLink`; `scrollWithin` (copy `diff-review/app/scroll-within.ts`'s approach into `app/scroll-within.ts`, noting the source).
- Produces:
  - `ORIENTATION_TAB_ID = "orientation"`; `OrientationTab(props: ExperimentalThreadTabProps & { params: unknown })` — reads `params.orientationId` with zod (an invalid param renders "This walkthrough is no longer available."); renders title, a **Contents** list of chapters (buttons that scroll the tab's own scroll container to the chapter), chapters with notes through `FileMarkdown` (`Listing N` mentions become buttons that scroll to that listing), and listings: heading `Listing N: caption`, an `experimental_FileLink` to `path` at `startLine–endLine` (or the moved range), a badge (**current**, **moved to A–B**, **changed since <sha7>**, **missing**), and the captured text in a `<pre><code>`. A **Verify** button calls `verifyOrientation`. Registered in `app.tsx` with `title: "Walkthrough"`, `icon: "FileText"` (in `herald/app/testing/bb-icon-names.ts`), `availability: "action"`, `context: { kind: "thread" }`, `layout: "padded"`.
  - `ExportDialog(props: { orientationId: string; onDone(): void })` — a path field (default `ORIENTATION.md`), **Export**; on `{ exists: true }` it shows "ORIENTATION.md already exists. Replace it?" with **Replace** (calls again with `replace: true`) and **Cancel**; on `{ written }` it shows "Wrote <path>."; refusals show their message. Every button `type="button"`.

- [ ] **Step 1: Write the failing tests:** the tab renders a moved listing's badge "moved to 52–84" and a link at that range; clicking a chapter in Contents sets the container's `scrollTop` (not `scrollIntoView`, which the test spies on and expects uncalled); an invalid `params` shows the unavailable message; the dialog asks before replacing and the second call carries `replace: true`.
- [ ] **Step 2: Run** `npx vitest run app/orientation-tab.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && env -u BB_CLI npx bb plugin build` — Expected: PASS and a clean build (check `dist/app.css` has no unknown variant classes you added).
- [ ] **Step 5: Commit** `git commit -m "learning-exercises: the walkthrough tab and the export dialog"`

---

### Task 14: Docs, notices and the 0.3.0 version

**Files:**
- Modify: `README.md`, `PLUGIN_OVERVIEW.md`, `CHANGELOG.md`, `AGENTS.md`, `NOTICE.md`, `package.json`, `package-lock.json`

- [ ] **Step 1:** `npm version minor --no-git-tag-version` — Expected: `v0.3.0`, lockfile updated.
- [ ] **Step 2:** `CHANGELOG.md` `## 0.3.0`, user-facing: an orientation for a project from the Learning tab; optionally with a walkthrough whose code is copied from your files and checked for changes; an orientation session in its own thread; export to a Markdown file in the repo; it runs a background agent with permission to read and edit files, told not to edit.
- [ ] **Step 3:** `README.md` "What it does" gains an **Orientation** bullet group; `PLUGIN_OVERVIEW.md` gains one paragraph (keep under 4,000 characters: `wc -m PLUGIN_OVERVIEW.md`).
- [ ] **Step 4:** `AGENTS.md`: invariant 1 and 3 text from spec §2; a new `## Orientation` section (builder lifecycle and its fail-closed reconcile, listings captured by the server, verify states, export with `expectedSha256`, the `"spawn"` session mode and that it does not count toward the per-thread cap); new rows in the file table; remove "Orientation" and "Showboat" from the later-phases sentence.
- [ ] **Step 5:** `NOTICE.md`: replace "this plugin does not include it yet" with the orient entry (work, author Dr. Michael Mullarkey, commit `3862d2e`, CC BY 4.0, not affiliated) and a table row per new content file with what was adapted and how; add the orient bibliography's six references; add a **showboat** section (Simon Willison, https://github.com/simonw/showboat, commit `d531261`, Apache-2.0): the document shape, the listing/output block pair and the verify behaviour are followed; no code or text is copied, so no Apache licence text ships.
- [ ] **Step 6: Run** `node ../.github/scripts/check-plugin-consistency.mjs && npm test && npm run typecheck` — Expected: all pass.
- [ ] **Step 7: Commit** `git commit -m "learning-exercises 0.3.0: Orient, with a native walkthrough"`

---

### Task 15: Live check in a dev bb

**Files:** none (findings go into `AGENTS.md` if anything surprises).

- [ ] **Step 1:** Start the dev bb and point a CLI at it exactly as the root `AGENTS.md` "A dev bb for live checks" describes; install with `bb plugin install path:$PWD --yes` there.
- [ ] **Step 2:** In a thread on a checkout of this repository: **Orient me to this project** without a walkthrough. Expected: a ready summary with 6–10 key files and 2 exercises; the builder thread archived (`bb thread list --archived` shows it).
- [ ] **Step 3:** **Rebuild** with **Include a walkthrough**. Expected: blocks count up live; the old summary stays until ready; **Read walkthrough** opens the tab with chapters and listings all *current*.
- [ ] **Step 4:** Insert two lines at the top of a listed file, **Verify**. Expected: that listing *moved*; edit inside it, **Verify**: *changed*. Revert the file.
- [ ] **Step 5:** **Export to repo…** twice. Expected: second time asks to replace. If `uvx` is available on the machine, run `uvx showboat verify ORIENTATION.md` from the checkout — Expected: exit 0. Delete the exported file.
- [ ] **Step 6:** **Start orientation session**: Expected: a visible "Orientation: …" thread, two exercise cards then the closing question, a finish summary naming a follow-up; the source thread's per-thread session count unchanged.
- [ ] **Step 7:** Start a build and `bb plugin reload learning-exercises` mid-build. Expected: the row `failed` ("Interrupted by a reload."), the builder archived, and a new build can start.
- [ ] **Step 8:** Record anything bb did differently from this plan in `learning-exercises/AGENTS.md` and commit `git commit -m "learning-exercises: notes from the Orient live check"`.
