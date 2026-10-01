/**
 * Builders and fakes shared by the server tests: a thread DTO, the three kinds
 * of pending interaction Herald describes, and a log that records instead of
 * printing.
 */
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";

import type { Interaction, Log, ThreadDto } from "../ports";

export function thread(overrides: Partial<ThreadDto> = {}): ThreadDto {
  return makeThreadResponse({ id: "t1", projectId: "p1", title: "Login fix", ...overrides });
}

const interactionBase = {
  createdAt: 1_000,
  providerId: "claude-code",
  providerRequestId: "r1",
  providerThreadId: "pt1",
  resolvedAt: null,
  status: "pending" as const,
  statusReason: null,
  threadId: "t1",
  turnId: "turn1",
};

export function question(overrides: { id?: string; questions?: number } = {}): Interaction {
  const extra = Array.from({ length: Math.max(0, (overrides.questions ?? 1) - 1) }, (_, index) => ({
    id: `q${index + 2}`,
    prompt: `Another question ${index + 2}?`,
    allowFreeText: false,
    multiSelect: false,
  }));
  return {
    ...interactionBase,
    id: overrides.id ?? "i1",
    payload: {
      kind: "user_question",
      questions: [
        {
          id: "q1",
          prompt: "Which DB?",
          allowFreeText: false,
          multiSelect: false,
          options: [
            { label: "Postgres", value: "pg" },
            { label: "SQLite", value: "sqlite" },
          ],
        },
        ...extra,
      ],
    },
    resolution: null,
  };
}

export function commandApproval(command: string, reason: string | null = null): Interaction {
  return {
    ...interactionBase,
    id: "i2",
    payload: {
      kind: "approval",
      availableDecisions: ["allow_once", "deny"],
      reason,
      subject: { kind: "command", command, cwd: null, itemId: "item1", actions: [], sessionGrant: null },
    },
    resolution: null,
  };
}

export function planApproval(plan: string): Interaction {
  return {
    ...interactionBase,
    id: "i3",
    payload: {
      kind: "approval",
      availableDecisions: ["allow_once", "deny"],
      reason: null,
      subject: { kind: "plan", plan, planFilePath: null, itemId: "item2" },
    },
    resolution: null,
  };
}

export function toolApproval(tool: string, title?: string, detail?: string): Interaction {
  return {
    ...interactionBase,
    id: "i4",
    payload: {
      kind: "approval",
      availableDecisions: ["allow_once", "deny"],
      reason: null,
      subject: {
        kind: "tool_use",
        itemId: "item3",
        tool,
        presentation: {
          icon: { glyph: "Globe" },
          label: { pending: "Using", completed: "Used" },
          ...(title === undefined ? {} : { title }),
          ...(detail === undefined ? {} : { detail }),
        },
      },
    },
    resolution: null,
  };
}

export interface RecordingLog extends Log {
  readonly lines: string[];
}

export function recordingLog(): RecordingLog {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(`info: ${message}`),
    warn: (message) => lines.push(`warn: ${message}`),
    error: (message) => lines.push(`error: ${message}`),
  };
}

/** Lets detached summaries and their store updates run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
