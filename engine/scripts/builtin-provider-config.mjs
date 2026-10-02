import { loadEndpointEnv } from "./load-endpoint-env.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repositoryRoot = resolve(import.meta.dirname, "..");

const BUILTIN_PROVIDER_CONFIG_FILE_ENV = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE";
const BUILTIN_PROVIDER_CONFIG_PATH = "config/provider/zcode-builtin.json";

/**
 * 解析构建期使用的 Built-in Provider 配置源。
 *
 * 运行时会把 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 指向随包产物，从正在运行的 comecode 派生的
 * 终端会继承它；照单全收就会出现源与目标同一个文件：构建正常结束，仓库里的改动却永远进不了
 * 产物。仓库内 dist 下的取值一律是上一轮构建产物（CLI 随包副本、agent 包工作目录等），因此忽略
 * 并回退到仓库配置；指向仓库外部的备用源仍然生效。
 */
export function resolveBuiltinProviderConfigSourcePath({
  root = repositoryRoot,
  env = process.env,
  warn = writeBuildWarning,
} = {}) {
  const repositoryConfigPath = resolve(root, BUILTIN_PROVIDER_CONFIG_PATH);
  const override = env[BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!override) return repositoryConfigPath;
  const overridePath = resolve(root, override);
  if (isRepositoryBuildOutput(root, overridePath)) {
    warn(
      `[builtin-provider-config] 忽略指向仓库构建产物的 ${BUILTIN_PROVIDER_CONFIG_FILE_ENV}（${overridePath}），改用 ${repositoryConfigPath}`,
    );
    return repositoryConfigPath;
  }
  return overridePath;
}

function isRepositoryBuildOutput(root, candidate) {
  const relativePath = relative(root, candidate);
  if (relativePath === "" || isAbsolute(relativePath) || relativePath.startsWith("..")) return false;
  return relativePath.split(/[\\/]/u).includes("dist");
}

function writeBuildWarning(message) {
  process.stderr.write(`${message}\n`);
}

/** @param {{root?: string, env?: Record<string, string | undefined>}} options */
export async function resolveBuiltinProviderBuildEnvironment({
  root = repositoryRoot,
  env = process.env,
} = {}) {
  let value = env.ZCODE_ENV;
  if (!value?.trim()) {
    const files = [
      ".env",
      ...(env.NODE_ENV === "production"
        ? [".env.production"]
        : [".env.development", ".env.development.local"]),
    ];
    for (const file of files) {
      let content;
      try {
        content = await readFile(resolve(root, file), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const parsed = parseEnv(content);
      if (parsed.ZCODE_ENV !== undefined) value = parsed.ZCODE_ENV;
    }
  }
  const normalized = value?.trim().toLowerCase() || "test";
  if (normalized !== "test" && normalized !== "production") {
    throw new Error(`Invalid ZCODE_ENV for Built-in Provider build: ${normalized}`);
  }
  return normalized;
}

/** @param {{root?: string, env?: Record<string, string | undefined>, warn?: (message: string) => void}} options */
export async function loadBuiltinProviderConfig({
  root = repositoryRoot,
  env = process.env,
  warn,
} = {}) {
  env = await loadEndpointEnv({ root, env });
  const environment = await resolveBuiltinProviderBuildEnvironment({ root, env });
  const sourcePath = resolveBuiltinProviderConfigSourcePath({ root, env, warn });
  try {
    const content = await readFile(sourcePath, "utf8");
    // 构建期复用运行时的完整 Release 校验，避免打包成功后才发现 Schema 不兼容。
    // tsx 仅供构建工具加载仓库 TS，不进入产品 bundle，也不复制一份校验规则。
    // Windows 绝对路径的盘符会被 ESM 当作协议，转为 file URL 后各平台共用同一加载入口。
    const { decodeZCodeBuiltinRelease } = await tsImport(
      pathToFileURL(resolve(repositoryRoot, "packages/provider-node/src/zcode-builtin-release.ts"))
        .href,
      import.meta.url,
    );
    decodeZCodeBuiltinRelease(JSON.parse(content));
    return { environment, sourcePath, content };
  } catch (error) {
    throw new Error(`Invalid Built-in Provider config (${environment}): ${sourcePath}`, {
      cause: error,
    });
  }
}

/** @param {{directory: string, root?: string, env?: Record<string, string | undefined>, warn?: (message: string) => void}} options */
export async function stageBuiltinProviderConfig({ directory, ...options }) {
  const config = await loadBuiltinProviderConfig(options);
  await mkdir(directory, { recursive: true });
  // bootstrap 可以复用 JS，但不能连带复用上一环境／上一版本的独立配置资源。
  await writeFile(resolve(directory, "zcode-builtin.json"), config.content, "utf8");
  return config;
}
