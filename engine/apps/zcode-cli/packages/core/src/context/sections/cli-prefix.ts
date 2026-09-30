// ============================================================
// CLI Prefix Section Builder
// ============================================================

import { PRODUCT_NAME } from "@zcode/contracts";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

// Modified by ComeCode：模型看到的产品身份改为 ComeCode（常量，保持 cache 前缀稳定）。
const CLI_PREFIX_PROMPT = `You are ${PRODUCT_NAME}, an interactive coding agent`;

export function buildCliPrefixSection(): ContextSection {
  const content = CLI_PREFIX_PROMPT;

  return {
    name: "CLI Prefix",
    source: "cli_prefix",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
