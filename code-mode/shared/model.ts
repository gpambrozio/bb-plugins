// Which Claude models Code Mode works with. Claude Code 2.1.332 says "for now it only works with Opus
// 5.5, Sonnet 5.5 and later models"; Fable 5.2 also runs it (the scout of Code Mode in bb). A session
// started in Code Mode can't resume on any other model, so the plugin refuses that switch.
//
// bb names Claude Code models by API id (`claude-opus-5-5`, `claude-haiku-4-5-20251001`), sometimes
// with a context suffix such as `[1m]`. An id this cannot read (an alias, a custom model) is "unknown":
// the plugin lets it through, and Claude Code decides.

export type ModelSupport = "supported" | "unsupported" | "unknown";

const MODEL_ID = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;

/** The oldest version of each family that runs Code Mode; a family missing here never does. */
const FIRST_SUPPORTED: Readonly<Record<string, readonly [number, number]>> = {
  opus: [5, 5],
  sonnet: [5, 5],
  fable: [5, 2],
};

export function codeModeSupport(model: string | null | undefined): ModelSupport {
  if (!model) return "unknown";
  const match = MODEL_ID.exec(model.trim().toLowerCase().replace(/\[[^\]]*\]$/, ""));
  if (!match) return "unknown";
  const [, family, major, minor] = match;
  const first = FIRST_SUPPORTED[family!];
  if (!first) return "unsupported";
  const version = [Number(major), Number(minor ?? 0)] as const;
  const atLeast = version[0] > first[0] || (version[0] === first[0] && version[1] >= first[1]);
  return atLeast ? "supported" : "unsupported";
}

export const SUPPORTED_MODELS_TEXT = "Opus 5.5, Sonnet 5.5, Fable 5.2 or a later model";
