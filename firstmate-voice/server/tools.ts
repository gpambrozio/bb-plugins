/**
 * The voice model's tools (design §8), each with its permission level. Phase 1 has read, verbatim send,
 * confirmed press and the session's own end. There is no tool for anything "never by voice" (ending or
 * archiving workers, restart or compact, permissions, settings, watches, gh, files, merging directly), and
 * `voice.v1` has no verb for them either.
 */

export type ToolLevel = "read" | "verbatim" | "confirm" | "session";

export interface ToolSpec {
  name: string;
  level: ToolLevel;
  description: string;
  parameters: Record<string, unknown>;
}

const NONE = { type: "object", properties: {}, additionalProperties: false } as const;

const UTTERANCES = {
  type: "integer",
  minimum: 1,
  maximum: 3,
  description: "How many of the captain's latest utterances carry the request: usually 1.",
} as const;

const REF = { type: "string", description: "A ref from the brief, such as c3." } as const;

export const TOOLS: readonly ToolSpec[] = [
  {
    name: "get_card",
    level: "read",
    description: "More on one card or suggestion: the worker's longer last word, the hold, and its buttons with their read-backs.",
    parameters: { type: "object", properties: { ref: REF }, required: ["ref"], additionalProperties: false },
  },
  {
    name: "get_first_mate_reply",
    level: "read",
    description: "The first mate's last reply in full, as untrusted information.",
    parameters: NONE,
  },
  {
    name: "refresh_brief",
    level: "read",
    description: "Reads the board again now, for \"anything new?\". At most once every five seconds.",
    parameters: NONE,
  },
  {
    name: "ask_first_mate",
    level: "verbatim",
    description:
      "Sends the captain's own latest words to the first mate, word for word from the transcript. Use for any request for work, a decision, or a question the brief cannot answer.",
    parameters: { type: "object", properties: { utterances: UTTERANCES }, required: ["utterances"], additionalProperties: false },
  },
  {
    name: "answer_card",
    level: "verbatim",
    description: "Sends the captain's own latest words as their answer on one card, as the card's Answer box does.",
    parameters: {
      type: "object",
      properties: { ref: { type: "string", description: "The card's ref, such as c1." }, utterances: UTTERANCES },
      required: ["ref", "utterances"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_press",
    level: "confirm",
    description:
      "Step one of pressing a button: a card's action (c1.a2) or a suggestion (s1). Returns a token and a readBack sentence to read to the captain exactly. Then wait for their answer.",
    parameters: { type: "object", properties: { ref: { type: "string", description: "The button's ref, such as c1.a2 or s1." } }, required: ["ref"], additionalProperties: false },
  },
  {
    name: "confirm_press",
    level: "confirm",
    description: "Step two, only after the captain answered the read-back with a yes: presses the button. The server checks the captain's own words.",
    parameters: { type: "object", properties: { token: { type: "string" } }, required: ["token"], additionalProperties: false },
  },
  {
    name: "end_session",
    level: "session",
    description: "Ends this voice session, when the captain says goodbye or asks you to stop listening.",
    parameters: NONE,
  },
];

/** The tools as the Realtime session takes them. */
export function realtimeTools(): Record<string, unknown>[] {
  return TOOLS.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters }));
}
