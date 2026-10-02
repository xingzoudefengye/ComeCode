import React from "react";
import {
  filterModelOptions,
  modelCommandQuery,
  reconcileModelCommandSelection,
  selectedModelOption,
} from "./app-input.js";
import type { ModelCommandSelectionState } from "./app-model.js";
import type { TuiModelOption, TuiOptions } from "./types.js";

export function useModelCommandController(
  draft: string,
  options: Pick<TuiOptions, "modelOptions" | "initialResult" | "listModelOptions">,
): {
  filteredOptions: readonly TuiModelOption[];
    reconcileDraft: (value: string) => ModelCommandSelectionState | undefined;
    openSelection: () => boolean;
    selectedOption: (submittedValue: string) => TuiModelOption | undefined;
    selection: ModelCommandSelectionState | undefined;
  setSelection: React.Dispatch<React.SetStateAction<ModelCommandSelectionState | undefined>>;
  setModelOptions: React.Dispatch<React.SetStateAction<readonly TuiModelOption[]>>;
} {
  const [modelOptions, setModelOptions] = React.useState<readonly TuiModelOption[]>(
    () => options.initialResult?.modelOptions ?? options.modelOptions ?? [],
  );
  const listModelOptions = options.listModelOptions;
  const [selection, setSelection] = React.useState<ModelCommandSelectionState | undefined>();
  const active = modelCommandQuery(draft) !== undefined;
  React.useEffect(() => {
    if (!active || !listModelOptions) return;
    let cancelled = false;
    void listModelOptions()
      .then((models) => {
        if (!cancelled) setModelOptions(models);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [active, listModelOptions]);
  const filteredOptions = React.useMemo(
    () => filterModelOptions(draft, modelOptions),
    [draft, modelOptions],
  );
  const reconcileDraft = React.useCallback(
    (value: string) => {
      setSelection(undefined);
      return undefined;
    },
    [],
  );
  const openSelection = React.useCallback(() => {
    if (selection || !active || filteredOptions.length === 0) return false;
    setSelection({ selectedIndex: 0 });
    return true;
  }, [active, filteredOptions.length, selection]);
  const selectedOption = React.useCallback(
    (submittedValue: string) => selectedModelOption(submittedValue, selection, filteredOptions),
    [filteredOptions, selection],
  );

  return {
    filteredOptions,
    openSelection,
    reconcileDraft,
    selectedOption,
    selection,
    setSelection,
    setModelOptions,
  };
}
