/**
 * Herald's section under the host-rendered settings form: what the form cannot
 * hold — the voices, which run to hundreds.
 */
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import type { RpcContract } from "../shared/contract";
import type { StoredConfig } from "../shared/herald";
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

  function saveVoices(voices: StoredConfig["voices"]): void {
    rpc.call("config.set", { voices }).then(setConfig, (cause: unknown) => toast.error(`Could not save: ${errorText(cause)}`));
  }

  if (config === null) return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;

  return (
    <div className="flex flex-col gap-6">
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
