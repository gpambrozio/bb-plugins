/**
 * Herald's section under the host-rendered settings form: what the form cannot
 * hold. Who writes the summaries (bb's model picker), the prompt they are
 * written from (a multi-line editor with its placeholders), and the voices,
 * which run to hundreds.
 */
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  useRpc,
  type ExperimentalProviderModelPickerValue,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import type { RpcContract } from "../shared/contract";
import {
  DEFAULT_SUMMARY_PROMPT,
  PROMPT_PLACEHOLDERS,
  REASONING_LEVELS,
  type StoredConfig,
  type SummarizerConfig,
} from "../shared/herald";
import { getAnnouncer } from "./announcer";
import { canPlaySpeech, listBrowserVoices, onVoicesChanged, type Voice } from "./speech";
import { VoicePicker } from "./voice-picker";

const TEST_SENTENCE = "This is Herald. Your agents will be announced like this.";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isReasoningLevel(value: string): value is SummarizerConfig["reasoningLevel"] {
  return (REASONING_LEVELS as readonly string[]).includes(value);
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

/**
 * The prompt's draft is local until Save, so the server is not written per
 * keystroke. Saving a draft that matches the default stores blank, so a user
 * who never customised the prompt follows the default as it changes.
 */
function PromptEditor({ stored, onSave }: { stored: string; onSave: (prompt: string) => Promise<void> }) {
  const current = stored.trim() === "" ? DEFAULT_SUMMARY_PROMPT : stored;
  const [draft, setDraft] = useState(current);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(current), [current]);
  const dirty = draft !== current;

  async function save() {
    setSaving(true);
    try {
      await onSave(draft.trim() === DEFAULT_SUMMARY_PROMPT.trim() ? "" : draft);
      toast.success("Summary prompt saved");
    } catch (error) {
      toast.error(`Could not save the prompt: ${errorText(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={14}
        aria-label="Summary prompt"
        className="font-mono text-xs"
      />
      {draft.includes("speech") ? null : (
        <p className="text-xs text-warning-text">
          The prompt no longer asks for the {"{\"speech\": …}"} object. Herald will speak the first 45 words of whatever the
          model replies, which is less predictable.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
          Save
        </Button>
        <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={() => setDraft(current)}>
          Cancel
        </Button>
        <Button size="sm" variant="outline" disabled={saving || draft === DEFAULT_SUMMARY_PROMPT} onClick={() => setDraft(DEFAULT_SUMMARY_PROMPT)}>
          Restore the default
        </Button>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">Placeholders</summary>
        <p className="mt-1 text-muted-foreground">
          A line whose placeholder has nothing to fill it for an event is left out whole, so keep a label and its placeholder
          on the same line. Anything else in double braces is sent as typed.
        </p>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {PROMPT_PLACEHOLDERS.map((placeholder) => (
            <div key={placeholder.name} className="contents">
              <dt className="font-mono">{`{{${placeholder.name}}}`}</dt>
              <dd className="text-muted-foreground">{placeholder.description}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
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

  async function save(patch: Partial<StoredConfig>): Promise<void> {
    setConfig(await rpc.call("config.set", patch));
  }

  function saveOrReport(patch: Partial<StoredConfig>): void {
    save(patch).catch((cause: unknown) => toast.error(`Could not save: ${errorText(cause)}`));
  }

  if (config === null) return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;

  const pick: ExperimentalProviderModelPickerValue = {
    providerId: config.summarizer.providerId,
    model: config.summarizer.model,
    reasoningLevel: config.summarizer.reasoningLevel,
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="space-y-2">
        <Heading title="Summary model">
          Each summary is one short turn of this model, through your own provider account, in a hidden thread that is stopped
          and deleted once its sentence is written.
        </Heading>
        <ProviderModelPicker
          value={pick}
          onChange={(value) =>
            saveOrReport({
              summarizer: {
                ...config.summarizer,
                providerId: value.providerId,
                model: value.model,
                reasoningLevel: isReasoningLevel(value.reasoningLevel) ? value.reasoningLevel : config.summarizer.reasoningLevel,
              },
            })
          }
        />
      </section>

      <section className="space-y-2">
        <Heading title="Summary prompt">The whole prompt each summary is written from, to edit however you like.</Heading>
        <PromptEditor stored={config.summarizer.prompt} onSave={(prompt) => save({ summarizer: { ...config.summarizer, prompt } })} />
      </section>

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
                onChange={(say) => saveOrReport({ voices: { ...config.voices, say } })}
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
              onChange={(web) => saveOrReport({ voices: { ...config.voices, web } })}
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
