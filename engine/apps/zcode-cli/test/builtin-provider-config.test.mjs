import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  resolveBuiltinProviderConfigSourcePath,
  stageBuiltinProviderConfig,
} from "../../../scripts/builtin-provider-config.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const repositoryConfigPath = resolve(repositoryRoot, "config/provider/zcode-builtin.json");
// 运行时 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 指向的就是这份随包产物。
const leakedOverridePath = resolve(
  repositoryRoot,
  "apps/zcode-cli/packages/cli/dist/provider/zcode-builtin.json",
);
// build-zcode.mjs 打出的 agent 包里还有一份副本，同样不能当作构建源。
const agentBundleCopyPath = resolve(
  repositoryRoot,
  "dist/zcode/.work/zcode/agent/provider/zcode-builtin.json",
);

test("未设置来源变量时使用仓库内置配置", () => {
  assert.equal(
    resolveBuiltinProviderConfigSourcePath({ root: repositoryRoot, env: {} }),
    repositoryConfigPath,
  );
});

test("指向上一次 CLI 构建产物的来源变量被忽略并告警", () => {
  const warnings = [];
  const resolved = resolveBuiltinProviderConfigSourcePath({
    root: repositoryRoot,
    env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: leakedOverridePath },
    warn: (message) => warnings.push(message),
  });

  assert.equal(resolved, repositoryConfigPath);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ZCODE_BUILTIN_PROVIDER_CONFIG_FILE/);
  assert.match(warnings[0], /zcode-builtin\.json/);
});

test("指向仓库内 agent 包副本的来源变量同样被忽略", () => {
  assert.equal(
    resolveBuiltinProviderConfigSourcePath({
      root: repositoryRoot,
      env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: agentBundleCopyPath },
      warn: () => {},
    }),
    repositoryConfigPath,
  );
});

test("指向仓库外部的来源变量继续生效", () => {
  assert.equal(
    resolveBuiltinProviderConfigSourcePath({
      root: repositoryRoot,
      env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(tmpdir(), "external-zcode-builtin.json") },
    }),
    join(tmpdir(), "external-zcode-builtin.json"),
  );
});

test("泄漏的运行时变量不会让产物取自旧 dist 副本", async (t) => {
  const stagingDirectory = await mkdtemp(join(tmpdir(), "comecode-builtin-stage-"));
  t.after(() => rm(stagingDirectory, { recursive: true, force: true }));

  const staged = await stageBuiltinProviderConfig({
    root: repositoryRoot,
    directory: stagingDirectory,
    env: { ZCODE_ENV: "test", ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: leakedOverridePath },
    warn: () => {},
  });

  assert.equal(staged.sourcePath, repositoryConfigPath);
  assert.equal(staged.content, await readFile(repositoryConfigPath, "utf8"));
  assert.equal(
    await readFile(join(stagingDirectory, "zcode-builtin.json"), "utf8"),
    staged.content,
  );
});
