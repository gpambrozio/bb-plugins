/**
 * A starting choice for the model picker: the first available provider's default model. The picker is
 * controlled and needs a real provider and model to show, so this is read once from bb's own catalog
 * rather than hard-coded; after that the captain's picks replace it.
 */
import { useSdk, type ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";

import { errorText } from "./notify";

export interface DefaultPick {
  pick: ExperimentalProviderModelPickerValue | null;
  /** Why no starting choice could be made. */
  error: string | null;
}

export function useDefaultPick(): DefaultPick {
  const sdk = useSdk();
  const [state, setState] = useState<DefaultPick>({ pick: null, error: null });

  useEffect(() => {
    let cancelled = false;
    async function find(): Promise<ExperimentalProviderModelPickerValue> {
      const providers = await sdk.providers.list();
      const provider = providers.find((candidate) => candidate.available) ?? providers[0];
      if (provider === undefined) throw new Error("bb has no agent providers to start a first mate with.");
      const { models } = await sdk.providers.models({ providerId: provider.id });
      const model = models.find((candidate) => candidate.isDefault) ?? models[0];
      if (model === undefined) throw new Error(`Provider ${provider.id} listed no models.`);
      return { providerId: provider.id, model: model.model, reasoningLevel: model.defaultReasoningEffort };
    }
    find().then(
      (pick) => {
        if (!cancelled) setState({ pick, error: null });
      },
      (caught: unknown) => {
        if (!cancelled) setState({ pick: null, error: errorText(caught) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sdk]);

  return state;
}
