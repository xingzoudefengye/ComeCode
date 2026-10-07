import { compactSchema } from "./schema.js";
import type { RuntimeConfigPatch } from "@zcode/contracts";
import type {
  UnifiedConfigDocument,
  UnifiedConfigDiagnostics,
  UnifiedProviderDefinition,
  UnifiedProviderType,
} from "./provider-config.js";
const CONFIG_FILE_NAME = "config.toml";

/** 仅解析 M2.1 所需的 TOML 子集，避免把复杂 TOML 依赖引入 CLI。 */
export function parseUnifiedConfigToml(
  text: string,
  filePath = CONFIG_FILE_NAME,
): {
  readonly document: UnifiedConfigDocument;
  readonly diagnostics: UnifiedConfigDiagnostics;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  let model: string | undefined;
  let provider: string | undefined;
  let section: string | undefined;
  let runtimeSection: "compact" | "features" | undefined;
  const compact: NonNullable<RuntimeConfigPatch["compact"]> = {};
  const features: Pick<NonNullable<RuntimeConfigPatch["features"]>, "compact"> = {};
  const providers: Record<string, UnifiedProviderDefinition> = {};

  const assign = (key: string, value: unknown, line: number): void => {
    if (runtimeSection === "compact") {
      if (key !== "resumeInputTokenThreshold") {
        warnings.push(`${filePath}:${line}: 忽略未知 compact 字段 ${key}`);
      } else {
        const parsed = compactSchema.safeParse({ resumeInputTokenThreshold: value });
        if (parsed.success) Object.assign(compact, parsed.data);
        else errors.push(`${filePath}:${line}: compact.resumeInputTokenThreshold 必须是非负整数`);
      }
      return;
    }
    if (runtimeSection === "features") {
      if (key !== "compact") warnings.push(`${filePath}:${line}: 忽略未知 features 字段 ${key}`);
      else if (typeof value !== "boolean") errors.push(`${filePath}:${line}: features.compact 必须是布尔值`);
      else features.compact = value;
      return;
    }
    if (!section && key === "model") {
      if (typeof value !== "string") errors.push(`${filePath}:${line}: model 必须是字符串`);
      else model = value;
      return;
    }
    if (!section && key === "provider") {
      if (typeof value !== "string") errors.push(`${filePath}:${line}: provider 必须是字符串`);
      else provider = value;
      return;
    }
    if (!section) {
      warnings.push(`${filePath}:${line}: 忽略未知配置字段 ${key}`);
      return;
    }
    const current = providers[section] ?? {};
    if (!["type", "base_url", "api_key_env", "api_key", "models", "enabled"].includes(key)) {
      warnings.push(`${filePath}:${line}: 忽略未知 Provider 字段 ${key}`);
      return;
    }
    if (["type", "base_url", "api_key_env", "api_key"].includes(key) && typeof value !== "string") {
      errors.push(`${filePath}:${line}: ${key} 必须是字符串`);
      return;
    }
    if (key === "enabled" && typeof value !== "boolean") {
      errors.push(`${filePath}:${line}: enabled 必须是布尔值`);
      return;
    }
    if (
      key === "models" &&
      (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    ) {
      errors.push(`${filePath}:${line}: models 必须是字符串数组`);
      return;
    }
    providers[section] = {
      ...current,
      ...(key === "type" ? { type: value as UnifiedProviderType } : {}),
      ...(key === "base_url" ? { baseUrl: value as string } : {}),
      ...(key === "api_key_env" ? { apiKeyEnv: value as string } : {}),
      ...(key === "api_key" ? { apiKey: value as string } : {}),
      ...(key === "enabled" ? { enabled: value as boolean } : {}),
      ...(key === "models" ? { models: value as string[] } : {}),
    };
  };

  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    const lineNumber = index + 1;
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (line === "[compact]" || line === "[features]") {
      runtimeSection = line === "[compact]" ? "compact" : "features";
      section = undefined;
      continue;
    }
    const sectionMatch = /^\[providers\.([^\]]+)\]$/u.exec(line);
    if (sectionMatch) {
      runtimeSection = undefined;
      const providerId = parseTomlKey(sectionMatch[1] ?? "");
      if (!providerId) {
        errors.push(`${filePath}:${lineNumber}: Provider ID 无效`);
        section = undefined;
      } else {
        section = providerId;
        providers[providerId] ??= {};
      }
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      errors.push(`${filePath}:${lineNumber}: 只支持 [providers.<id>]、[compact] 和 [features] 表`);
      runtimeSection = undefined;
      section = undefined;
      continue;
    }
    const separator = findEquals(line);
    if (separator < 0) {
      errors.push(`${filePath}:${lineNumber}: 缺少键值分隔符 =`);
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(key)) {
      errors.push(`${filePath}:${lineNumber}: 无效配置键 ${key}`);
      continue;
    }
    try {
      assign(key, parseTomlValue(line.slice(separator + 1).trim()), lineNumber);
    } catch (error) {
      errors.push(
        `${filePath}:${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    document: Object.freeze({ model, provider, providers: Object.freeze(providers),
      ...(Object.keys(compact).length ? { compact } : {}),
      ...(Object.keys(features).length ? { features } : {}),
    }),
    diagnostics: Object.freeze({
      errors: Object.freeze(errors),
      warnings: Object.freeze(warnings),
    }),
  };
}

function stripTomlComment(line: string): string {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && quoted) {
      escaped = !escaped;
      continue;
    }
    if (char === '"' && !escaped) quoted = !quoted;
    if (char === "#" && !quoted) return line.slice(0, index);
    escaped = false;
  }
  return line;
}

function findEquals(line: string): number {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') quoted = !quoted;
    if (line[index] === "=" && !quoted) return index;
  }
  return -1;
}

function parseTomlValue(value: string): string | boolean | number | string[] {
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value) as string;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/u.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => {
      const parsed = parseTomlValue(item.trim());
      if (typeof parsed !== "string") throw new Error("数组目前只支持字符串元素");
      return parsed;
    });
  }
  throw new Error(`不支持的 TOML 值 ${value}`);
}

function parseTomlKey(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return undefined;
    }
  }
  return /^[A-Za-z0-9._:-]+$/u.test(trimmed) ? trimmed : undefined;
}
