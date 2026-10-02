/**
 * Herald's section under the host-rendered settings form: what the form cannot
 * hold. The voices run to hundreds; and the model-written sentence's tool,
 * custom command and prompt belong together, with the command shown only
 * under "custom" — which the form cannot do, so all three live here, in the
 * stored configuration.
 */
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import type { RpcContract } from "../shared/contract";
import { DEFAULT_SENTENCE_PROMPT, SENTENCE_TOOLS, type SentenceTool, type StoredConfig } from "../shared/herald";
import { getAnnouncer } from "./announcer";
import { canPlaySpeech, listBrowserVoices, onVoicesChanged, type Voice } from "./speech";
import { VoicePicker } from "./voice-picker";

const TEST_SENTENCE = "This is Herald. Your agents will be announced like this.";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useBrowserVoices(): Voice[] {
  const [voices, setVoices] = useState<Voice[]>(() => listBrowserVoices());
  useEffect(() => onVoicesChanged(() => setVoices(listBrowserVoices())), []);
  return voices;
}

function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children === undefined ? null : <p className="text-xs text-muted-foreground">{children}</p>}
    </div>
  );
}

const TOOL_LABELS: Record<SentenceTool, string> = {
  claude: "claude — Claude Code, with no tools",
  codex: "codex — OpenAI Codex, read-only",
  gemini: "gemini — Gemini CLI, read-only plan mode",
  custom: "custom — a command of your own",
};

const FIELD_CLASS =
  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** A multi-line text with its own Save button; what the server holds wins over an unsaved draft when it changes underneath. */
function TextField({
  label,
  stored,
  rows,
  onSave,
  extra,
}: {
  label: string;
  stored: string;
  rows: number;
  onSave: (value: string) => void;
  extra?: ReactNode;
}) {
  const [draft, setDraft] = useState(stored);
  useEffect(() => setDraft(stored), [stored]);
  return (
    <div className="space-y-2">
      <textarea aria-label={label} className={`${FIELD_CLASS} min-h-16`} rows={rows} value={draft} spellCheck={false} onChange={(event) => setDraft(event.target.value)} />
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={draft === stored} onClick={() => onSave(draft)}>
          Save {label.split(" ").pop()?.toLowerCase()}
        </Button>
        {extra}
      </div>
    </div>
  );
}

/** The tool, the custom command (only under custom) and the prompt, together. */
function ModelSentence({ config, onSave }: { config: StoredConfig; onSave: (next: Partial<StoredConfig>) => void }) {
  return (
    <section className="space-y-3">
      <Heading title="Model-written sentences">
        Applies while <em>Write each sentence with a model</em> is on above. The tool must be installed and logged in on the Mac running
        bb; it runs there once per announcement with the prompt on standard input, and the last paragraph of its standard output becomes
        the sentence.
      </Heading>
      <div className="space-y-1">
        <p className="text-xs font-semibold">Tool that writes the sentence</p>
        <select
          aria-label="Tool that writes the sentence"
          className={`${FIELD_CLASS} font-sans`}
          value={config.sentenceTool}
          onChange={(event) => onSave({ sentenceTool: event.target.value as SentenceTool })}
        >
          {SENTENCE_TOOLS.map((tool) => (
            <option key={tool} value={tool}>
              {TOOL_LABELS[tool]}
            </option>
          ))}
        </select>
      </div>
      {config.sentenceTool === "custom" ? (
        <div className="space-y-1">
          <p className="text-xs font-semibold">Custom command</p>
          <p className="text-xs text-muted-foreground">
            Filled in from the tool you had selected, to start from. No shell runs it: quote as in a shell, but ~ and $VARIABLES are not
            expanded, and it sees the bb server&apos;s environment. Blank means the plain sentence.
          </p>
          <TextField label="Custom command" stored={config.sentenceCommand} rows={3} onSave={(sentenceCommand) => onSave({ sentenceCommand })} />
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="text-xs font-semibold">Sentence prompt</p>
        <p className="text-xs text-muted-foreground">
          Placeholders: {"{{thread}}, {{project}}, {{folder}}, {{event}}, {{headline}}, {{detail}}, {{request}}"} and {"{{output}}"}.
        </p>
        <TextField
          label="Sentence prompt"
          stored={config.sentencePrompt}
          rows={10}
          onSave={(sentencePrompt) => onSave({ sentencePrompt })}
          extra={
            config.sentencePrompt === DEFAULT_SENTENCE_PROMPT ? null : (
              <Button size="sm" variant="ghost" onClick={() => onSave({ sentencePrompt: DEFAULT_SENTENCE_PROMPT })}>
                Reset to the default prompt
              </Button>
            )
          }
        />
      </div>
    </section>
  );
}

export function HeraldSettingsSection() {
  const rpc = useRpc<RpcContract>();
  const [config, setConfig] = useState<StoredConfig | null>(null);
  const [sayVoices, setSayVoices] = useState<{ available: boolean; voices: Voice[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const browserVoices = useBrowserVoices();

  useEffect(() => {
    rpc.call("config.get", {}).then(setConfig, (cause: unknown) => setError(errorText(cause)));
    rpc.call("speech.voices", {}).then(setSayVoices, (cause: unknown) => {
      setSayVoices({ available: false, voices: [] });
      console.warn("[herald] could not list the server's voices", cause);
    });
  }, [rpc]);

  /** The answer is the whole stored configuration — with the custom command the server seeded, when it did. */
  function save(next: Partial<StoredConfig>): void {
    rpc.call("config.set", next).then(setConfig, (cause: unknown) => toast.error(`Could not save: ${errorText(cause)}`));
  }

  function saveVoices(voices: StoredConfig["voices"]): void {
    save({ voices });
  }

  if (config === null) return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;

  return (
    <div className="flex flex-col gap-6">
      <ModelSentence config={config} onSave={save} />
      {canPlaySpeech() ? (
        <section className="space-y-3">
          <Heading title="Voices">
            Shared by every device. To add Mac voices, install them on the Mac running bb under System Settings → Accessibility →
            Spoken Content.
          </Heading>
          <div className="space-y-1">
            <p className="text-xs font-semibold">Mac voice (Voice source: say)</p>
            {sayVoices === null ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : sayVoices.available ? (
              <VoicePicker
                label="Mac voices"
                voices={sayVoices.voices}
                value={config.voices.say}
                defaultLabel="The Mac's default voice"
                onChange={(say) => saveVoices({ ...config.voices, say })}
              />
            ) : (
              <p className="text-xs text-muted-foreground">bb does not run on a Mac here, so the browser voice is used.</p>
            )}
          </div>
          <div className="space-y-1">
            <p className="text-xs font-semibold">Browser voice (Voice source: web, and the fallback)</p>
            <VoicePicker
              label="Browser voices"
              voices={browserVoices}
              value={config.voices.web}
              defaultLabel="This browser's default voice"
              onChange={(web) => saveVoices({ ...config.voices, web })}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const announcer = getAnnouncer();
              if (announcer === null) return;
              announcer.speakText(TEST_SENTENCE, { force: true }).catch((cause: unknown) => toast.error(errorText(cause)));
            }}
          >
            Test voice
          </Button>
        </section>
      ) : null}
    </div>
  );
}
