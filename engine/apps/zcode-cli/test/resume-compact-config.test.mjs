import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    const sources = {
      "@zcode/contracts": "../packages/contracts/src/index.ts",
      "@zcode/adapters/config": "../packages/adapters/src/config/index.ts",
    };
    return nextResolve(
      sources[specifier] ? new URL(sources[specifier], import.meta.url).href : specifier,
      context,
    );
  },
});
const { createConfig, createConfigPort, ZCodeConfigFileSchema } =
  await import("../packages/adapters/src/config/index.ts");
const { ConfigKey, ConfigScope } = await import("../packages/contracts/src/config/index.ts");
const { parseUnifiedConfigJson } =
  await import("../packages/adapters/src/config/provider-config-json.ts");
const { parseUnifiedConfigToml } =
  await import("../packages/adapters/src/config/provider-config-toml.ts");
const { resolveAppRuntimeConfig } = await import("../packages/bootstrap/src/app/runtime-config.ts");

function runtime(configResult, compact) {
  return resolveAppRuntimeConfig({
    configResult,
    options: { env: {}, runtimeConfig: compact === undefined ? {} : { compact } },
    cliStorageRoot: "fixture",
    workingDirectory: "fixture",
    subagentOutputRootDir: "fixture",
  }).runtimeConfig;
}

test("恢复阈值接受0和正整数，拒绝非法配置及显式运行值", () => {
  for (const value of [0, 1, 51200, 100000]) {
    assert.equal(
      ZCodeConfigFileSchema.parse({ compact: { resumeInputTokenThreshold: value } }).compact
        .resumeInputTokenThreshold,
      value,
    );
  }
  const configResult = { config: createConfigPort().getAll() };
  for (const value of [-1, 1.5, "51200", null, true, Infinity, NaN]) {
    assert.throws(() =>
      ZCodeConfigFileSchema.parse({ compact: { resumeInputTokenThreshold: value } }),
    );
    assert.throws(() => runtime(configResult, { resumeInputTokenThreshold: value }));
  }
  assert.equal(runtime(configResult).compact.resumeInputTokenThreshold, undefined);
});

test("恢复配置按用户、项目、CLI合并，runtime显式值优先且保留原compact参数", () => {
  const port = createConfigPort();
  port.merge({ compact: { resumeInputTokenThreshold: 60000 } }, ConfigScope.User);
  port.merge({ compact: { resumeInputTokenThreshold: 0 } }, ConfigScope.Project);
  assert.equal(port.get(ConfigKey.CompactResumeInputTokenThreshold), 0);
  assert.equal(
    port.getSources(ConfigKey.CompactResumeInputTokenThreshold)[0].scope,
    ConfigScope.Project,
  );
  const configResult = { config: port.getAll() };
  assert.equal(runtime(configResult).compact.resumeInputTokenThreshold, 0);
  assert.deepEqual(
    runtime(configResult, {
      enabled: false,
      contextRatioThreshold: 0.8,
      resumeInputTokenThreshold: 70000,
    }).compact,
    { enabled: false, contextRatioThreshold: 0.8, resumeInputTokenThreshold: 70000 },
  );
  port.merge(
    { features: { compact: false }, compact: { resumeInputTokenThreshold: 60000 } },
    ConfigScope.Cli,
  );
  configResult.config = port.getAll();
  assert.deepEqual(runtime(configResult).compact, { resumeInputTokenThreshold: 0 });
  assert.equal(
    runtime(configResult, { resumeInputTokenThreshold: 80000 }).compact.resumeInputTokenThreshold,
    80000,
  );
});

test("标准compact开关保留旧用户关闭的功能，高优先级显式值可覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "comecode-features-preserve-"));
  try {
    const user = join(root, "user", ".comecode");
    await mkdir(join(user, "cli"), { recursive: true });
    await writeFile(
      join(user, "cli", "config.json"),
      JSON.stringify({ features: { mcp: false, memory: false, subagent: false } }),
    );
    await writeFile(join(user, "config.json"), '{"features":{"compact":false}}');
    const options = { env: { COMECODE_DATA_BASE_DIR: join(root, "user") } };
    const result = createConfig(options);
    for (const feature of ["compact", "mcp", "memory", "subagent"]) {
      assert.equal(result.config.features[feature], false);
    }
    const overridden = createConfig({
      ...options,
      cliOverrides: { features: { mcp: true, memory: true, subagent: true } },
    });
    assert.equal(overridden.config.features.compact, false);
    for (const feature of ["mcp", "memory", "subagent"]) {
      assert.equal(overridden.config.features[feature], true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const extension of ["json", "jsonc", "toml"]) {
  test(`标准${extension}用户/项目配置接通恢复阈值并隔离真实配置`, async () => {
    const root = await mkdtemp(join(tmpdir(), "comecode-resume-config-"));
    try {
      const user = join(root, "user", ".comecode");
      const project = join(root, "project");
      await mkdir(user, { recursive: true });
      await mkdir(join(project, ".comecode"), { recursive: true });
      const userText =
        extension === "toml"
          ? "[compact]\nresumeInputTokenThreshold = 60000\n"
          : '{"compact":{"resumeInputTokenThreshold":60000}}';
      const projectText =
        extension === "toml"
          ? "[compact]\nresumeInputTokenThreshold = 0\n"
          : extension === "jsonc"
            ? '{ // project override\n"compact":{"resumeInputTokenThreshold":0,},}'
            : '{"compact":{"resumeInputTokenThreshold":0}}';
      await writeFile(join(user, `config.${extension}`), userText);
      await writeFile(join(project, ".comecode", `config.${extension}`), projectText);
      const result = createConfig({
        env: { COMECODE_DATA_BASE_DIR: join(root, "user") },
        workingDirectory: project,
      });
      assert.equal(result.config.compact.resumeInputTokenThreshold, 0);
      assert.equal(runtime(result).compact.resumeInputTokenThreshold, 0);
      const overridden = createConfig({
        env: { COMECODE_DATA_BASE_DIR: join(root, "user") },
        workingDirectory: project,
        cliOverrides: { compact: { resumeInputTokenThreshold: 90000 } },
      });
      assert.equal(overridden.config.compact.resumeInputTokenThreshold, 90000);
      await writeFile(
        join(project, ".comecode", `config.${extension}`),
        extension === "toml"
          ? "[compact]\nresumeInputTokenThreshold = -1\n"
          : '{"compact":{"resumeInputTokenThreshold":-1}}',
      );
      const invalid = createConfig({
        env: { COMECODE_DATA_BASE_DIR: join(root, "user") },
        workingDirectory: project,
        loggerFactory: {
          createLogger: () => ({
            child() {
              return this;
            },
            warn() {},
          }),
        },
      });
      assert.equal(invalid.config.compact.resumeInputTokenThreshold, 60000);
      assert.ok(
        invalid.sources.project.diagnostics.some(
          (diagnostic) => diagnostic.code === "config_file_invalid",
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("标准配置读取恢复阈值时不迁移或改写插件配置", async () => {
  const root = await mkdtemp(join(tmpdir(), "comecode-resume-readonly-"));
  try {
    const user = join(root, "user", ".comecode");
    await mkdir(user, { recursive: true });
    const file = join(user, "config.json");
    const source = JSON.stringify({
      compact: { resumeInputTokenThreshold: 51200 },
      plugins: { enabledPlugins: { "@zcode/computer-use": true } },
    });
    await writeFile(file, source);
    const result = createConfig({ env: { COMECODE_DATA_BASE_DIR: join(root, "user") } });
    assert.equal(result.config.compact.resumeInputTokenThreshold, 51200);
    assert.equal(await readFile(file, "utf8"), source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Provider JSON/JSONC/TOML接受恢复配置和旧开关并校验非法值", () => {
  for (const [parse, source] of [
    [
      parseUnifiedConfigJson,
      '{"compact":{"resumeInputTokenThreshold":0},"features":{"compact":false}}',
    ],
    [
      parseUnifiedConfigToml,
      "[compact]\nresumeInputTokenThreshold = 0\n[features]\ncompact = false\n",
    ],
  ]) {
    const parsed = parse(source);
    assert.deepEqual(parsed.diagnostics.errors, []);
    assert.equal(parsed.document.compact.resumeInputTokenThreshold, 0);
    assert.equal(parsed.document.features.compact, false);
    assert.ok(parse(source.replace("0", "-1")).diagnostics.errors.length);
  }
});
