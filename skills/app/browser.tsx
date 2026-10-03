/**
 * The list, the search, both detail screens and **Add to chat** — everything
 * the Skills panel shows, drawn by the panel and by the composer button's
 * popover alike, so a skill added from either lands in the message box the
 * same way.
 *
 * `onAdded` is what happens after **Add to chat** has put the command in the
 * composer, and the one thing the two callers do differently: the panel moves
 * to the thread, while the popup closes over a composer that is already the
 * thread's.
 *
 * Every button here says `type="button"`. bb draws the composer popup inside
 * the composer's `<form>`, where a button with no type submits the form — it
 * would send the message.
 */
import { Markdown } from "@get-bb/plugin-sdk/app";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { type ReportedSkill, type SkillEntry, type SkillList, SOURCE_KINDS } from "../shared/skills";
import { discoveredCommand, reportedCommand, type SkillCommand } from "./insert";
import { withoutImages } from "./markdown";
import { type Loaded, useAddToChat, useSkillDocument } from "./use-skills";

/** The skill a browser shows the detail of; also the panel's `params`, so it is plain JSON. */
export type Selection = { kind: "discovered"; id: string } | { kind: "reported"; name: string };

/** A selection read back from a panel tab's persisted `params`, or null for anything else. */
export function selectionFrom(params: unknown): Selection | null {
  const skill = (params as { skill?: unknown } | null)?.skill as Record<string, unknown> | undefined;
  if (skill?.kind === "discovered" && typeof skill.id === "string") return { kind: "discovered", id: skill.id };
  if (skill?.kind === "reported" && typeof skill.name === "string") return { kind: "reported", name: skill.name };
  return null;
}

/**
 * Where the browser is drawn. The panel is a tab the host scrolls and pads; the
 * composer popup is a small surface, so the path and **Copy path** stay in the
 * panel, which is for locating a skill as well as using it.
 */
export type SkillBrowserFrame = "panel" | "popup";

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "acp-hermes-agent": "Hermes",
};

// Groups render in precedence order, not in whatever order the alphabetical
// list happens to introduce them.
export function groupBySource(skills: SkillEntry[]): Array<{ label: string; skills: SkillEntry[] }> {
  const groups = new Map<string, { kind: SkillEntry["source"]["kind"]; skills: SkillEntry[] }>();
  for (const skill of skills) {
    const existing = groups.get(skill.source.label);
    if (existing) existing.skills.push(skill);
    else groups.set(skill.source.label, { kind: skill.source.kind, skills: [skill] });
  }
  return [...groups]
    .sort(([labelA, groupA], [labelB, groupB]) => {
      const rank = SOURCE_KINDS.indexOf(groupA.kind) - SOURCE_KINDS.indexOf(groupB.kind);
      return rank !== 0 ? rank : labelA.localeCompare(labelB);
    })
    .map(([label, group]) => ({ label, skills: group.skills }));
}

function matches(term: string, skill: { name: string; description: string }): boolean {
  return term.length === 0 || skill.name.toLowerCase().includes(term) || skill.description.toLowerCase().includes(term);
}

function GroupLabel({ children }: { children: ReactNode }) {
  return <h3 className="mt-4 mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</h3>;
}

function Row({ name, hint, description, onSelect }: { name: string; hint?: string; description: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="block w-full cursor-pointer rounded-md px-2 py-2 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="block truncate text-sm font-medium text-foreground">
        {name}
        {hint ? <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">{hint}</span> : null}
      </span>
      {description ? <span className="line-clamp-2 text-xs text-muted-foreground">{description}</span> : null}
    </button>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <Button type="button" variant="link" size="sm" className="mb-2 h-auto px-0" onClick={onBack}>
      ← All skills
    </Button>
  );
}

/**
 * **Add to chat**, shared by both detail screens. Shown only where the composer
 * it would write to is this thread's.
 */
function AddToChat({ threadId, command, onAdded }: { threadId: string; command: SkillCommand; onAdded: () => void }) {
  const chat = useAddToChat(threadId, onAdded);
  if (!chat.canAdd) return null;
  return (
    <Button type="button" className="my-3 w-full" onClick={() => chat.add(command)}>
      Add to chat
    </Button>
  );
}

function copyPath(path: string): void {
  // The path is selectable text too, so a client that denies programmatic
  // copying still leaves select-and-copy.
  void navigator.clipboard.writeText(path).then(
    () => toast.success("Path copied"),
    () => toast.error("Could not copy. Select the path and copy it instead."),
  );
}

function SkillDetail({
  threadId,
  frame,
  skillId,
  entry,
  onBack,
  onAdded,
}: {
  threadId: string;
  frame: SkillBrowserFrame;
  skillId: string;
  /** The skill's row in the list, or undefined while the list is loading. */
  entry: SkillEntry | undefined;
  onBack: () => void;
  onAdded: () => void;
}) {
  const { state } = useSkillDocument(threadId, skillId);

  return (
    <div>
      <BackLink onBack={onBack} />
      {state.status === "loading" ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : state.status === "error" ? (
        <p className="text-sm text-destructive">{state.message}</p>
      ) : (
        <>
          <h2 className="text-base font-semibold text-foreground">{state.data.name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{state.data.description}</p>
          {frame === "panel" ? (
            <div className="mt-2 flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all font-mono text-xs text-muted-foreground select-text">
                {state.data.path}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => copyPath(state.data.path)}
              >
                Copy path
              </Button>
            </div>
          ) : null}
          {(entry?.userInvocable ?? true) ? (
            <AddToChat
              threadId={threadId}
              command={discoveredCommand(state.data.name, entry?.source.kind)}
              onAdded={onAdded}
            />
          ) : (
            <p className="my-3 text-sm text-muted-foreground">
              This skill is model-invoked only. The agent can use it, but it has no command to add to the chat.
            </p>
          )}
          <div className="border-t border-border pt-3">
            <Markdown content={withoutImages(state.data.body)} className="text-sm" />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Detail for an entry bb's provider reported. There is no `SKILL.md` behind it,
 * so no path and no body — but the description shows in full rather than
 * clipped to two lines, and its command can still be added to the chat.
 */
function ReportedDetail({
  threadId,
  entry,
  source,
  onBack,
  onAdded,
}: {
  threadId: string;
  entry: ReportedSkill;
  /** Which of the provider's two lists it is in. */
  source: SkillCommand["source"];
  onBack: () => void;
  onAdded: () => void;
}) {
  return (
    <div>
      <BackLink onBack={onBack} />
      <h2 className="text-base font-semibold text-foreground">{entry.name}</h2>
      {entry.argumentHint ? <p className="font-mono text-xs text-muted-foreground">{entry.argumentHint}</p> : null}
      {entry.description ? <p className="mt-2 text-sm text-muted-foreground select-text">{entry.description}</p> : null}
      <AddToChat threadId={threadId} command={reportedCommand(entry, source)} onAdded={onAdded} />
      <p className="text-sm text-muted-foreground">
        bb's provider reported this. It has no SKILL.md on disk, so there is nothing further to show.
      </p>
    </div>
  );
}

function ReportedGroup({
  label,
  note,
  entries,
  onSelect,
}: {
  label: string;
  note: string;
  entries: ReportedSkill[];
  onSelect: (name: string) => void;
}) {
  return (
    <section>
      <GroupLabel>{label}</GroupLabel>
      <p className="mb-1 text-xs text-muted-foreground">{note}</p>
      {entries.map((entry) => (
        <Row
          key={entry.name}
          name={entry.name}
          hint={entry.argumentHint}
          description={entry.description}
          onSelect={() => onSelect(entry.name)}
        />
      ))}
    </section>
  );
}

export function SkillBrowser({
  threadId,
  frame,
  list,
  onAdded,
  initialSelection = null,
  onSelectionChange,
}: {
  threadId: string;
  frame: SkillBrowserFrame;
  list: Loaded<SkillList>;
  onAdded: () => void;
  /** The skill to open on, as **Open in panel** hands it over from the popover. */
  initialSelection?: Selection | null;
  onSelectionChange?: (selection: Selection | null) => void;
}) {
  const [search, setSearch] = useState("");
  // Discovered entries are addressed by their id; reported ones have none and
  // are addressed by name, which the server keeps unique across both buckets.
  const [selected, setSelected] = useState<Selection | null>(initialSelection);

  useEffect(() => {
    onSelectionChange?.(selected);
  }, [selected, onSelectionChange]);
  const top = useRef<HTMLDivElement>(null);

  // A page opened from far down the list starts at its own top, and so does the
  // list returned to.
  useEffect(() => {
    top.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // A thread switch under an open panel or popover is a new list.
  const shownThread = useRef(threadId);
  useEffect(() => {
    if (shownThread.current === threadId) return;
    shownThread.current = threadId;
    setSelected(null);
    setSearch("");
  }, [threadId]);

  // The selection is cleared first, so the browser is back on its list when the
  // user returns to it rather than on the detail of a skill already added.
  function handleAdded() {
    setSelected(null);
    onAdded();
  }

  const term = search.trim().toLowerCase();
  const data = list.status === "ready" ? list.data : null;
  const filtered = useMemo(() => (data?.skills ?? []).filter((skill) => matches(term, skill)), [data, term]);
  const reportedSkills = useMemo(() => (data?.reported.skills ?? []).filter((skill) => matches(term, skill)), [data, term]);
  const reportedCommands = useMemo(
    () => (data?.reported.commands ?? []).filter((skill) => matches(term, skill)),
    [data, term],
  );

  // A refetch can drop an entry the provider no longer reports; the browser
  // goes back to its list rather than keep a selection for something gone.
  const reportedNames = data === null ? null : [...data.reported.skills, ...data.reported.commands].map((entry) => entry.name);
  const selectedGone = selected?.kind === "reported" && reportedNames !== null && !reportedNames.includes(selected.name);
  useEffect(() => {
    if (selectedGone) setSelected(null);
  }, [selectedGone]);

  let content: ReactNode;
  if (selected?.kind === "discovered") {
    const entry = data?.skills.find((skill) => skill.id === selected.id);
    content = (
      <SkillDetail
        threadId={threadId}
        frame={frame}
        skillId={selected.id}
        entry={entry}
        onBack={() => setSelected(null)}
        onAdded={handleAdded}
      />
    );
  } else if (selected?.kind === "reported") {
    const named = (candidate: ReportedSkill) => candidate.name === selected.name;
    const skill = data?.reported.skills.find(named);
    const entry = skill ?? data?.reported.commands.find(named);
    content =
      entry === undefined ? null : (
        <ReportedDetail
          threadId={threadId}
          entry={entry}
          source={skill === undefined ? "command" : "skill"}
          onBack={() => setSelected(null)}
          onAdded={handleAdded}
        />
      );
  }

  if (content === undefined || content === null) {
    content =
      list.status === "loading" ? (
        <p className="text-sm text-muted-foreground">Loading skills…</p>
      ) : list.status === "error" ? (
        <p className="text-sm text-destructive">{list.message}</p>
      ) : (
        <>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search skills"
            aria-label="Search skills"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
          />
          {list.data.scanned ? null : (
            <p className="mt-2 text-xs text-muted-foreground">
              Skill files are only scanned for Claude Code, Codex and Hermes. Everything else below is what bb and
              its {PROVIDER_NAMES[list.data.provider] ?? list.data.provider} provider report.
            </p>
          )}
          {filtered.length === 0 &&
          reportedSkills.length === 0 &&
          reportedCommands.length === 0 &&
          list.data.reported.error === null ? (
            <p className="mt-3 text-sm text-muted-foreground">
              {term.length > 0 ? "No skills match that search." : "No skills found."}
            </p>
          ) : null}
          {groupBySource(filtered).map((group) => (
            <section key={group.label}>
              <GroupLabel>{group.label}</GroupLabel>
              {group.skills.map((skill) => (
                <Row
                  key={skill.id}
                  name={skill.name}
                  description={skill.description}
                  onSelect={() => setSelected({ kind: "discovered", id: skill.id })}
                />
              ))}
            </section>
          ))}
          {list.data.reported.error ? (
            <section>
              <GroupLabel>Reported by the provider</GroupLabel>
              <p className="text-sm text-destructive">{list.data.reported.error}</p>
            </section>
          ) : null}
          {reportedSkills.length > 0 ? (
            <ReportedGroup
              label="Built-in skills"
              note="What bb's / menu offers that no scanned directory holds. These have no SKILL.md to read."
              entries={reportedSkills}
              onSelect={(name) => setSelected({ kind: "reported", name })}
            />
          ) : null}
          {reportedCommands.length > 0 ? (
            <ReportedGroup
              label="Built-in commands"
              note="Session controls the provider reported, not skills."
              entries={reportedCommands}
              onSelect={(name) => setSelected({ kind: "reported", name })}
            />
          ) : null}
        </>
      );
  }

  return (
    <div className={cn(frame === "popup" && "p-3")}>
      <div ref={top} />
      {content}
    </div>
  );
}
