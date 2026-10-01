/**
 * A searchable, scrolling list of voices. A Mac has around two hundred `say`
 * voices in fifty languages, far past what a select can hold, so the list
 * filters by name or language as you type.
 */
import { useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface VoiceOption {
  name: string;
  lang: string;
}

export function VoicePicker({
  label,
  voices,
  value,
  defaultLabel,
  onChange,
  disabled = false,
}: {
  label: string;
  voices: readonly VoiceOption[];
  /** The chosen voice's name; empty for the default voice. */
  value: string;
  defaultLabel: string;
  onChange: (name: string) => void;
  disabled?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === "") return voices;
    return voices.filter((voice) => voice.name.toLowerCase().includes(needle) || voice.lang.toLowerCase().includes(needle));
  }, [voices, filter]);
  const missing = value !== "" && !voices.some((voice) => voice.name === value);

  function option(name: string, title: string, detail: string | null) {
    const selected = name === value;
    return (
      <li key={name === "" ? "(default)" : name}>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={selected}
          onClick={() => onChange(name)}
          className={cn(
            "flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-state-hover",
            selected && "bg-state-active font-semibold",
          )}
        >
          <span className="min-w-0 truncate">{title}</span>
          {detail === null ? null : <span className="shrink-0 text-xs text-muted-foreground">{detail}</span>}
        </button>
      </li>
    );
  }

  return (
    <div className="space-y-2">
      <Input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder={`Filter ${voices.length} voices by name or language`}
        aria-label={`Filter ${label}`}
        disabled={disabled}
      />
      {missing ? (
        <p className="text-xs text-warning-text">"{value}" is not installed here; the default voice is used instead.</p>
      ) : null}
      <ul aria-label={label} className="max-h-60 overflow-y-auto rounded-md border border-border p-1">
        {option("", defaultLabel, null)}
        {shown.map((voice) => option(voice.name, voice.name, voice.lang))}
      </ul>
    </div>
  );
}
