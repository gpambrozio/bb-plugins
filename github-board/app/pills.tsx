/**
 * The small facts a card and the panel both show: checks, branch state,
 * linked issues and labels.
 */
import type { BoardItem, BranchStatus, CheckSummary } from "../shared/board";
import { cn } from "@/lib/utils";
import { behindSentence, checksSentence, linkedIssueLabel, staleBranch } from "./board-logic";

const PILL = "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] leading-none";

/**
 * A count per outcome, as bb's own checks summary spells it; an outcome nobody
 * has is left out. The glyphs carry the meaning, so it reads without colour.
 */
export function ChecksPills({ checks }: { checks: CheckSummary }) {
  return (
    <span className={cn(PILL, "border-border")} aria-label={`Checks: ${checksSentence(checks)}`}>
      {checks.passed > 0 ? <span className="text-muted-foreground">✓ {checks.passed}</span> : null}
      {checks.failed > 0 ? <span className="text-destructive">✕ {checks.failed}</span> : null}
      {checks.pending > 0 ? <span className="text-primary">● {checks.pending}</span> : null}
    </span>
  );
}

/**
 * Warning for a branch that is merely behind, where the button may fix it;
 * destructive for conflicts, which someone has to resolve by hand.
 */
export function BranchPill({ branch }: { branch: BranchStatus }) {
  return (
    <span
      className={cn(PILL, branch.conflicts ? "border-destructive text-destructive" : "border-warning text-warning-text")}
      title={behindSentence(branch)}
    >
      {branch.conflicts ? "Conflicts" : "Out of date"}
    </span>
  );
}

const SHOWN_LABELS = 3;

/** Up to three labels and a `+N`, so a card never silently hides one. */
export function LabelChips({ labels, all = false }: { labels: readonly string[]; all?: boolean }) {
  const shown = all ? labels : labels.slice(0, SHOWN_LABELS);
  const rest = labels.length - shown.length;
  return (
    <>
      {shown.map((label) => (
        <span key={label} className={cn(PILL, "max-w-[12rem] truncate border-border text-muted-foreground")}>
          {label}
        </span>
      ))}
      {rest > 0 ? <span className={cn(PILL, "border-border text-muted-foreground")}>+{rest}</span> : null}
    </>
  );
}

/** Everything a card's footer carries, checks first: the footer wraps, and they matter most. */
export function ItemPills({ item, allLabels = false }: { item: BoardItem; allLabels?: boolean }) {
  const branch = staleBranch(item.branch);
  return (
    <>
      {item.checks !== null ? <ChecksPills checks={item.checks} /> : null}
      {branch !== null ? <BranchPill branch={branch} /> : null}
      {item.linkedIssues.map((issue) => (
        <span key={issue.id} className={cn(PILL, "border-border text-foreground")}>
          {linkedIssueLabel(issue, item.repository)}
        </span>
      ))}
      <LabelChips labels={item.labels} all={allLabels} />
    </>
  );
}
