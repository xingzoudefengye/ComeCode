import { z } from "zod";
import { compactSchema } from "./schema.js";
import type { UnifiedConfigDiagnostics, UnifiedConfigDocument } from "./provider-config.js";

const nonBlank = z.string().trim().min(1);
const connectionShape = {
  type: z.enum(["openai-chat", "openai-responses", "anthropic", "gemini"]).optional(),
  baseUrl: nonBlank.optional(),
  apiKey: nonBlank.optional(),
  apiKeyEnv: nonBlank.optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  toolCalling: z.boolean().optional(),
  vision: z.boolean().optional(),
  reasoningLevel: nonBlank.optional(),
};
const modelSchema = z
  .object({ id: nonBlank, name: nonBlank.optional(), enabled: z.boolean().optional(), ...connectionShape })
  .strict();
const providerSchema = modelSchema.extend({
  models: z.array(z.union([nonBlank, modelSchema])).optional(),
});
const documentSchema = z
  .object({
    model: nonBlank.optional(),
    provider: nonBlank.optional(),
    providers: z.array(providerSchema).optional(),
    compact: compactSchema.optional(),
    features: z.object({ compact: z.boolean().optional() }).optional(),
  })
  .strict();

/** JSON/JSONC 只负责文件边界校验，解析错误不能把包含密钥的源文本带入日志。 */
export function parseUnifiedConfigJson(
  text: string,
  filePath = "config.json",
): {
  readonly document: UnifiedConfigDocument;
  readonly diagnostics: UnifiedConfigDiagnostics;
} {
  const errors: string[] = [];
  const empty = { document: { providers: {} }, diagnostics: { errors, warnings: [] } };
  let input: unknown;
  try {
    const source = text.replace(/^\uFEFF/u, "");
    input = JSON.parse(filePath.endsWith(".jsonc") ? normalizeJsonc(source) : source);
  } catch {
    errors.push(`${filePath}: JSON 语法错误，请检查引号、逗号及括号（带注释请使用 .jsonc）`);
    return empty;
  }
  const parsed = documentSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      errors.push(
        `${filePath}: ${issue.path.join(".") || "顶层"} 字段类型或结构无效 (${issue.code})`,
      );
    return empty;
  }
  const providers: UnifiedConfigDocument["providers"] = Object.fromEntries(
    (parsed.data.providers ?? []).map(({ id, ...definition }) => [id, definition]),
  );
  const ids = new Set<string>();
  for (const provider of parsed.data.providers ?? []) {
    if (ids.has(provider.id)) errors.push(`${filePath}: 重复 Provider id ${provider.id}`);
    ids.add(provider.id);
    if (provider.apiKey && provider.apiKeyEnv)
      errors.push(`${filePath}: Provider ${provider.id} 的 apiKey 与 apiKeyEnv 只能填写一个`);
    const modelIds = new Set<string>();
    for (const model of provider.models ?? []) {
      const id = typeof model === "string" ? model : model.id;
      if (modelIds.has(id)) errors.push(`${filePath}: Provider ${provider.id} 重复模型 id ${id}`);
      modelIds.add(id);
      if (typeof model === "object" && model.apiKey && model.apiKeyEnv)
        errors.push(`${filePath}: 模型 ${id} 的 apiKey 与 apiKeyEnv 只能填写一个`);
    }
  }
  return {
    document: { model: parsed.data.model, provider: parsed.data.provider, providers, ...(parsed.data.compact ? { compact: parsed.data.compact } : {}), ...(parsed.data.features ? { features: parsed.data.features } : {}), ...(parsed.data.providers ? { ownsProviderMembership: true } : {}) },
    diagnostics: { errors, warnings: [] },
  };
}

/** 保留字符串中的 URL 和注释符号；只移除字符串外的注释和尾逗号。 */
export function normalizeJsonc(source: string): string {
  let result = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      result += char;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index++;
      result += "\n";
    } else if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw new Error("注释未闭合");
      result += " ";
      index = end + 1;
    } else result += char;
  }
  let normalized = "";
  quoted = false;
  escaped = false;
  for (let index = 0; index < result.length; index++) {
    const char = result[index]!;
    if (!quoted && char === "," && /^\s*[}\]]/u.test(result.slice(index + 1))) continue;
    normalized += char;
    if (escaped) escaped = false;
    else if (quoted && char === "\\") escaped = true;
    else if (char === '"') quoted = !quoted;
  }
  return normalized;
}
