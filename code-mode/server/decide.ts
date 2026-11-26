// Whether a new thread starts in Code Mode. Pure: the hook and the resolver gather the facts, this
// applies the rules, in this order:
//
// 1. A fork resumes its source's session, so it takes the source's choice, whatever the settings say.
// 2. "Send in Code Mode" on the thread's first message turns it on, or refuses the send when this
//    machine is not turned on or the model can't run Code Mode, saying why.
// 3. Otherwise the default: the project's switch for a thread a person started; for a thread an agent
//    or a plugin started, the spawned-threads setting (the project's switch, never, or the same as the
//    thread that started it). A default that would put a thread in Code Mode on a machine that is not
//    turned on, or on a model that can't run it, leaves it off.
import { codeModeSupport, SUPPORTED_MODELS_TEXT } from "../shared/model";
import type { CodeModeRecord } from "../shared/record";
import type { SpawnedRule } from "../shared/settings";

export interface DecisionFacts {
  /** The thread was forked from `forkSource`'s thread; null when it is not a fork. */
  fork: { sourceRecord: CodeModeRecord | null } | null;
  /** true from "Send in Code Mode"; null when the send did not say. */
  explicit: boolean | null;
  /** An agent or a plugin started the thread, not a person. */
  spawned: boolean;
  spawnedRule: SpawnedRule;
  /** The record of the thread that started this one, for the "parent" rule. */
  parentRecord: CodeModeRecord | null;
  projectDefault: boolean;
  hostAllowed: boolean;
  /** The model the first turn asks for; null when bb has not resolved one. */
  model: string | null;
}

export type Decision = { kind: "record"; codeMode: CodeModeRecord["codeMode"]; reason: string } | { kind: "reject"; message: string };

function on(reason: string): Decision {
  return { kind: "record", codeMode: "on", reason };
}

function off(reason: string): Decision {
  return { kind: "record", codeMode: "off", reason };
}

export function decide(facts: DecisionFacts): Decision {
  if (facts.fork) {
    return facts.fork.sourceRecord?.codeMode === "on" ? on("forked from a Code Mode thread") : off("forked from a thread without Code Mode");
  }
  const unsupportedModel = codeModeSupport(facts.model) === "unsupported";
  if (facts.explicit === true) {
    if (!facts.hostAllowed) {
      return {
        kind: "reject",
        message: "Code Mode is not turned on for this machine. Turn it on in Code Mode's settings (Settings → Plugins → Code Mode), or send the message normally.",
      };
    }
    if (unsupportedModel) {
      return {
        kind: "reject",
        message: `Code Mode only works with ${SUPPORTED_MODELS_TEXT}, and this thread is set to ${facts.model}. Pick one of those models, or send the message normally.`,
      };
    }
    return on("chosen in the Send menu");
  }
  if (facts.explicit === false) return off("sent without Code Mode");

  let wanted: boolean;
  let why: string;
  if (facts.spawned && facts.spawnedRule === "off") {
    wanted = false;
    why = "started by an agent or a plugin";
  } else if (facts.spawned && facts.spawnedRule === "parent") {
    wanted = facts.parentRecord?.codeMode === "on";
    why = wanted ? "same as the thread that started it" : "the thread that started it is not in Code Mode";
  } else {
    wanted = facts.projectDefault;
    why = wanted ? "the project's default" : "the project's default is off";
  }
  if (!wanted) return off(why);
  if (!facts.hostAllowed) return off("Code Mode is not turned on for this machine");
  if (unsupportedModel) return off(`the model ${facts.model} can't run Code Mode`);
  return on(why);
}

/** The model guard: a Code Mode thread may not move to a model that can't resume its session. */
export function modelGuard(record: CodeModeRecord | null, model: string | null): string | null {
  if (record?.codeMode !== "on" || codeModeSupport(model) !== "unsupported") return null;
  return `This thread runs in Code Mode, which only works with ${SUPPORTED_MODELS_TEXT}, so it can't continue on ${model}. Switch the thread back to one of those models and send again.`;
}
