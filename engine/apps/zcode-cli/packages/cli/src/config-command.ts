import { runProviderConfigSetup } from "./provider-config-setup.js";
import { existsSync } from "node:fs";
import { formatJson } from "@zcode/core";
import {
  resolveUnifiedConfig,
  resolveUnifiedConfigPaths,
  toPublicUnifiedConfig,
} from "@zcode/adapters/config";
import type { RunContext, GlobalOptions } from "@zcode/shared-types";
import type { RunDependencies } from "./cli-types.js";

export async function runConfigCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  args: readonly string[],
  cliOverrides: { readonly model?: string; readonly provider?: string } = {},
): Promise<number> {
  const subcommand = args[0] ?? "show";
  if (args.length > 1 || !["path", "show", "check", "setup"].includes(subcommand)) {
    ctx.stderr.write("用法: comecode config <setup|path|show|check>\n");
    return 1;
  }
  const cwd = (deps.cwd ?? process.cwd)();
  const env = deps.env ?? process.env;
  if (subcommand === "setup") return runProviderConfigSetup(ctx, env, cwd);
  if (subcommand === "path") {
    const paths = resolveUnifiedConfigPaths({ cwd, env });
    const payload = {
      user: { path: paths.user, exists: existsSync(paths.user) },
      project: {
        path: paths.project ?? paths.projectCandidates[0],
        exists: paths.project !== undefined,
        candidates: [...paths.projectCandidates],
      },
      legacyProvider: { path: paths.legacyProviderFile, exists: existsSync(paths.legacyProviderFile) },
    };
    if (options.json) ctx.stdout.write(formatJson(payload));
    else {
      ctx.stdout.write(`用户配置: ${payload.user.path} (${payload.user.exists ? "存在" : "未找到"})\n`);
      ctx.stdout.write(`项目配置: ${payload.project.path} (${payload.project.exists ? "存在" : "未找到"})\n`);
      ctx.stdout.write(`旧 Provider 配置: ${payload.legacyProvider.path} (${payload.legacyProvider.exists ? "存在" : "未找到"})\n`);
    }
    return 0;
  }

  const resolved = await resolveUnifiedConfig({ cwd, env, cliOverrides });
  if (subcommand === "show") {
    const publicConfig = toPublicUnifiedConfig(resolved);
    ctx.stdout.write(
      formatJson({
        paths: {
          user: publicConfig.paths.user,
          ...(publicConfig.paths.project ? { project: publicConfig.paths.project } : {}),
          projectCandidates: [...publicConfig.paths.projectCandidates],
          legacyProviderFile: publicConfig.paths.legacyProviderFile,
        },
        ...(publicConfig.model ? { model: publicConfig.model } : {}),
        ...(publicConfig.provider ? { provider: publicConfig.provider } : {}),
        hasSource: publicConfig.hasSource,
        providers: publicConfig.providers.map((provider) => ({
          id: provider.id,
          ...(provider.type ? { type: provider.type } : {}),
          ...(provider.apiType ? { apiType: provider.apiType } : {}),
          ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
          ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
          ...(provider.apiKeySource ? { apiKeySource: provider.apiKeySource } : {}),
          models: [...provider.models],
          executable: provider.executable,
        })),
        diagnostics: {
          errors: [...publicConfig.diagnostics.errors],
          warnings: [...publicConfig.diagnostics.warnings],
        },
      }),
    );
    return 0;
  }

  const hasSelectedProvider = resolved.provider
    ? resolved.providers.some((provider) => provider.id === resolved.provider && provider.executable)
    : false;
  const payload = {
    ok: resolved.diagnostics.errors.length === 0 &&
      (resolved.provider ? hasSelectedProvider : resolved.providers.some((provider) => provider.executable)),
    errors: [...resolved.diagnostics.errors,
      ...(!resolved.providers.some((provider) => provider.executable) ? ["没有可用模型。运行 comecode config setup 完成配置。"] : []),
    ],
    warnings: [...resolved.diagnostics.warnings],
    ...(resolved.provider && resolved.model
      ? { selected: { provider: resolved.provider, model: resolved.model } }
      : {}),
  };
  ctx.stdout.write(formatJson(payload));
  return payload.ok ? 0 : 1;
}

