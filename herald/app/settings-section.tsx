/**
 * Herald's section under the host-rendered settings form: what the form cannot
 * hold — the voices, which run to hundreds, and the custom command, which only
 * applies when the form's tool is "custom" and the form cannot hide a field.
 */
import { useRealtime, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import type { RpcContract } from "../shared/contract";
import { CONFIG_CHANNEL, type StoredConfig } from "../shared/herald";
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

/** The custom command: a text area and a Save button, shown only while the form's tool is "custom". */
function CustomCommand({ stored, onSave }: { stored: string; onSave: (command: string) => void }) {
  const [draft, setDraft] = useState(stored);
  // What the server holds wins over an unsaved draft when it changes underneath — the seeded command arriving.
  useEffect(() => setDraft(stored), [stored]);
  return (
    <section className="space-y-3">
      <Heading title="Custom command">
        Runs on the Mac running bb with the prompt on standard input; the last paragraph of its standard output becomes the sentence.
        No shell runs it: quote as in a shell, but ~ and $VARIABLES are not expanded, and it sees the bb server&apos;s environment.
        Blank means the plain sentence.
      </Heading>
      <textarea
        aria-label="Custom command"
        className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        value={draft}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button size="sm" variant="outline" disabled={draft === stored} onClick={() => onSave(draft)}>
        Save command
      </Button>
    </section>
  );
}

export function HeraldSettingsSection() {
  const rpc = useRpc<RpcContract>();
  const { values } = useSettings();
  const [config, setConfig] = useState<StoredConfig | null>(null);
  const [sayVoices, setSayVoices] = useState<{ available: boolean; voices: Voice[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const browserVoices = useBrowserVoices();

  const readConfig = useCallback(() => {
    rpc.call("config.get", {}).then(setConfig, (cause: unknown) => setError(errorText(cause)));
  }, [rpc]);

  useEffect(() => {
    readConfig();
    rpc.call("speech.voices", {}).then(setSayVoices, (cause: unknown) => {
      setSayVoices({ available: false, voices: [] });
      console.warn("[herald] could not list the server's voices", cause);
    });
  }, [rpc, readConfig]);
  // The server seeds the custom command when the tool becomes "custom", and says so here.
  useRealtime(CONFIG_CHANNEL, readConfig);

  function save(next: Partial<StoredConfig>): void {
    rpc.call("config.set", next).then(setConfig, (cause: unknown) => toast.error(`Could not save: ${errorText(cause)}`));
  }

  function saveVoices(voices: StoredConfig["voices"]): void {
    save({ voices });
  }

  if (config === null) return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;

  return (
    <div className="flex flex-col gap-6">
      {values?.sentenceTool === "custom" ? <CustomCommand stored={config.sentenceCommand} onSave={(sentenceCommand) => save({ sentenceCommand })} /> : null}
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
