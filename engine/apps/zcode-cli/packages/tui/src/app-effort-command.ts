import React from "react";
import { filterEffortOptions, selectedEffortOption } from "./app-input.js";
import type { EffortCommandSelectionState } from "./app-model.js";
import type { TuiEffortOption } from "./types.js";

export function useEffortCommandController(
  draft: string,
  effortOptions: readonly TuiEffortOption[],
): {
  filteredOptions: readonly TuiEffortOption[];
  openSelection: (value?: string) => boolean;
  reconcileDraft: (value: string) => EffortCommandSelectionState | undefined;
  selectedOption: (submittedValue: string) => TuiEffortOption | undefined;
  selection: EffortCommandSelectionState | undefined;
  setSelection: React.Dispatch<React.SetStateAction<EffortCommandSelectionState | undefined>>;
} {
  const [selection, setSelection] = React.useState<EffortCommandSelectionState | undefined>();
  const filteredOptions = React.useMemo(
    () => filterEffortOptions(draft, effortOptions),
    [draft, effortOptions],
  );
  const reconcileDraft = React.useCallback((_value: string) => {
    setSelection(undefined);
    return undefined;
  }, []);
  const openSelection = React.useCallback(
    (value = draft) => {
      if (selection || filterEffortOptions(value, effortOptions).length === 0) return false;
      setSelection({ selectedIndex: 0 });
      return true;
    },
    [draft, effortOptions, selection],
  );
  const selectedOption = React.useCallback(
    (submittedValue: string) => selectedEffortOption(submittedValue, selection, filteredOptions),
    [filteredOptions, selection],
  );

  return {
    filteredOptions,
    openSelection,
    reconcileDraft,
    selectedOption,
    selection,
    setSelection,
  };
}
