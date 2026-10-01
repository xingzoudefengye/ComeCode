import { useCallback, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { isValidClipboardImage } from "./app-input.js";
import type { PromptInputEditor } from "./app-input-pane.js";
import type { DraftAttachment } from "./app-model.js";
import type { TuiOptions } from "./types.js";

type UseClipboardImagePasteOptions = {
  abortControllerRef: MutableRefObject<AbortController | undefined>;
  busy: boolean;
  getDraftValue: () => string;
  inputEditorRef: MutableRefObject<PromptInputEditor | null>;
  nextAttachmentIdRef: MutableRefObject<number>;
  options: TuiOptions;
  setDraftAttachments: Dispatch<SetStateAction<DraftAttachment[]>>;
  setDraftValue: (value: string) => void;
  setStatus: Dispatch<SetStateAction<string>>;
  setStatusDetails: Dispatch<SetStateAction<string[]>>;
};

export function useClipboardImagePaste({
  abortControllerRef,
  busy,
  getDraftValue,
  inputEditorRef,
  nextAttachmentIdRef,
  options,
  setDraftAttachments,
  setDraftValue,
  setStatus,
  setStatusDetails,
}: UseClipboardImagePasteOptions): () => Promise<void> {
  const readingRef = useRef(false);
  return useCallback(async () => {
    if (readingRef.current) return;
    if (busy) {
      setStatus("图片：请等待当前回复结束后再粘贴。");
      return;
    }
    if (!options.readClipboardImage) {
      setStatus("图片：当前终端未接入剪贴板读取。");
      return;
    }

    readingRef.current = true;
    try {
      setStatusDetails([]);
      setStatus("图片：正在读取剪贴板…");
      const image = await options.readClipboardImage({
        abortSignal: abortControllerRef.current?.signal,
      });
      if (!image) {
        setStatus("图片：剪贴板中没有图片，请先复制截图，再粘贴或输入 /paste。");
        return;
      }
      if (!isValidClipboardImage(image)) {
        setStatus("图片：剪贴板图片格式不受支持。");
        return;
      }

      const id = nextAttachmentIdRef.current++;
      const placeholder = `[image #${id}]`;
      const attachment: DraftAttachment = {
        dataUrl: image.dataUrl,
        id,
        mediaType: image.mediaType,
        placeholder,
        sizeBytes: image.sizeBytes,
        type: "image",
      };
      setDraftAttachments((current) => [...current, attachment]);
      if (!insertPlaceholderIntoEditor(inputEditorRef.current, placeholder)) {
        setDraftValue(appendedImagePlaceholder(getDraftValue(), placeholder));
      }
      setStatus(`图片：已添加 ${placeholder}，输入问题后按回车发送。`);
    } catch (error) {
      setStatus("图片：读取剪贴板失败，请重新复制截图后再试。");
      setStatusDetails([error instanceof Error ? error.message : String(error)]);
    } finally {
      readingRef.current = false;
    }
  }, [
    abortControllerRef,
    busy,
    getDraftValue,
    inputEditorRef,
    nextAttachmentIdRef,
    options,
    setDraftAttachments,
    setDraftValue,
    setStatus,
    setStatusDetails,
  ]);
}

function appendedImagePlaceholder(draft: string, placeholder: string): string {
  // 本地 /paste 是操作指令，成功后只保留图片占位符，不作为用户正文提交。
  const trimmed = draft.trim() === "/paste" ? "" : draft.trimEnd();
  return trimmed ? `${trimmed} ${placeholder}` : placeholder;
}

function insertPlaceholderIntoEditor(
  editor: PromptInputEditor | null,
  placeholder: string,
): boolean {
  if (!editor) return false;
  editor.setText(appendedImagePlaceholder(editor.plainText, placeholder));
  editor.gotoBufferEnd();
  return true;
}
