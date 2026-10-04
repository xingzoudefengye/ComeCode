import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { KeyEvent } from "@mbears/opentui-core";
import type { TuiWorkflowExpansionControls } from "./app-workflow-controller.js";
import type {
  ApprovalPrompt,
  DraftAttachment,
  EffortCommandSelectionState,
  Message,
  ModeCommandSelectionState,
  ModelCommandSelectionState,
  SelectionState,
  SubmitValueOptions,
  SlashCommand,
  SlashSelectionState,
} from "./app-model.js";
import type { SidebarSectionId } from "./app-sidebar-layout.js";
import type { TuiEffortOption, TuiModeOption, TuiModelOption } from "./types.js";

export type UseTuiKeyboardControlsOptions = {
  readOnlyView?: { back(): void };
  abortControllerRef: MutableRefObject<AbortController | undefined>;
  approvalQueue: ApprovalPrompt[];
  busy: boolean;
  copyCurrentSelection: () => boolean;
  draftValue: string;
  workflowExpansion?: TuiWorkflowExpansionControls;
  filteredEffortOptions: readonly TuiEffortOption[];
  filteredModeOptions: readonly TuiModeOption[];
  filteredModelOptions: readonly TuiModelOption[];
  filteredSlashCommands: readonly SlashCommand[];
  handleFileMentionKey: (key: KeyEvent) => boolean;
  openModelSelection: (value?: string) => boolean;
  openEffortSelection: (value?: string) => boolean;
  openModeSelection: (value?: string) => boolean;
  inputHistoryActive: boolean;
  messages: readonly Message[];
  effortSelection: EffortCommandSelectionState | undefined;
  modelSelection: ModelCommandSelectionState | undefined;
  modeSelection: ModeCommandSelectionState | undefined;
  onExit: (code: number) => void;
  pasteClipboardImage: () => Promise<void>;
  recallNextInput: () => Promise<void>;
  recallPreviousInput: () => Promise<void>;
  selection: SelectionState | undefined;
  setApprovalQueue: Dispatch<SetStateAction<ApprovalPrompt[]>>;
  setDraftAttachments: Dispatch<SetStateAction<DraftAttachment[]>>;
  setDraftValue: (value: string) => void;
  setEffortSelection: Dispatch<SetStateAction<EffortCommandSelectionState | undefined>>;
  setModelSelection: Dispatch<SetStateAction<ModelCommandSelectionState | undefined>>;
  setModeSelection: Dispatch<SetStateAction<ModeCommandSelectionState | undefined>>;
  setSelection: Dispatch<SetStateAction<SelectionState | undefined>>;
  setSlashSelection: Dispatch<SetStateAction<SlashSelectionState | undefined>>;
  setStatus: Dispatch<SetStateAction<string>>;
  slashSelection: SlashSelectionState | undefined;
  submitValue: (value: string, options?: SubmitValueOptions) => Promise<void>;
  switchMode: () => void;
  toggleSidebar: () => boolean;
  toggleSidebarSection: (section: SidebarSectionId) => boolean;
};
