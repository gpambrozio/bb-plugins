/** The words the Review tab shows for the stored values. */
import { rangeText } from "../shared/git-spec";
import type { DeliveryState, Severity, Target, ThreadStatus } from "../shared/types";

export const SEVERITY_LABELS: Record<Severity, string> = {
  "must-fix": "Must fix",
  suggestion: "Suggestion",
  nit: "Nit",
  question: "Question",
};

export const STATUS_LABELS: Record<ThreadStatus, string> = {
  open: "Open",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

export const DELIVERY_LABELS: Record<DeliveryState, string> = {
  sent: "Sent · waiting for the agent",
  answered: "Agent answered",
  no_reply: "No reply from the agent",
};

/** The target picker's label for a view. */
export function targetLabel(target: Target): string {
  switch (target.kind) {
    case "uncommitted":
      return "Uncommitted changes";
    case "branch":
      return `Committed since ${target.base}`;
    case "all":
      return `All changes since ${target.base}`;
    case "commit":
      return `Commit ${target.sha.slice(0, 7)}`;
    case "staged":
      return "Staged changes";
    case "unstaged":
      return "Unstaged changes";
    case "range":
      return `Range ${rangeText(target)}`;
    case "files":
      return "Any file";
  }
}

/** A short "5 min ago" for comment times. */
export function ago(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}
