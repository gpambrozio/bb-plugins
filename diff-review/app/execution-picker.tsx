/**
 * The provider, model and reasoning an AI run starts with: bb's own picker, starting from the plugin's
 * settings (Claude Code unless changed), with its catalog read from the reviewed workspace.
 */
import { experimental_ProviderModelPicker as ProviderModelPicker, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";

import type { RpcContract } from "../shared/contract";
import type { Execution } from "../shared/types";
import { errorMessage } from "./use-review";

/** Where the picker starts when bb cannot say: Claude Code, its default model. */
const FALLBACK: Execution = { providerId: "claude-code", model: "", reasoningLevel: "medium" };

/** The starting choice for a thread's runs, read once each time `active` turns on. */
export type RunPermissionMode = "auto" | "accept-edits";

export function useRunDefaults(threadId: string, active: boolean) {
  const rpc = useRpc<RpcContract>();
  const [execution, setExecution] = useState<Execution | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<RunPermissionMode>("auto");
  useEffect(() => {
    if (!active) return;
    let live = true;
    setExecution(null);
    setMessage(null);
    rpc
      .call("runDefaults", { threadId })
      .then((result) => {
        if (!live) return;
        setExecution(result.execution ?? FALLBACK);
        setMessage(result.message);
        setPermissionMode(result.permissionMode);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setExecution(FALLBACK);
        setMessage(errorMessage(error));
      });
    return () => {
      live = false;
    };
  }, [rpc, threadId, active]);
  return { execution, setExecution, message, permissionMode };
}

export function ExecutionPicker({
  environmentId,
  execution,
  onChange,
  message,
  permissionMode,
  disabled,
}: {
  environmentId: string;
  execution: Execution | null;
  onChange(value: Execution): void;
  message: string | null;
  permissionMode: RunPermissionMode;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">
        Runs in a new thread under this one, in the same workspace, in {permissionMode === "auto" ? "Approve for me" : "Accept edits"} mode (set in Diff
        Review's settings).
      </span>
      {execution === null ? (
        <span className="text-xs text-muted-foreground">Loading the providers…</span>
      ) : (
        <ProviderModelPicker
          value={execution}
          onChange={onChange}
          routing={{ kind: "environment", environmentId }}
          disabled={disabled}
        />
      )}
      {message === null ? null : <span className="text-xs text-warning-text">{message}</span>}
    </div>
  );
}
