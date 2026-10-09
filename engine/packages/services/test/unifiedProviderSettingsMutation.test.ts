import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUnifiedProviderSettingsMutationTarget } from "../src/model-provider/unifiedProviderSettingsMutation.js";
import { createProviderConfigEditor } from "@zcode/adapters/config";
import { ProviderMutationStaleError } from "@zcode/provider";

const provider = {
  id: "shared-api",
  type: "openai-chat",
  baseUrl: "https://example.test/v1",
  apiKey: "test-only-key",
  models: [{ id: "model-a" }, { id: "model-b" }],
};

test("桌面 Provider Settings mutation 与 Web editor 共用 config.json，删除不被旧投影复活", async () => {
  const root = await mkdtemp(join(tmpdir(), "comecode-desktop-config-"));
  const dataRoot = join(root, "user");
  const projection = join(root, "runtime", "provider_config.json");
  await mkdir(dataRoot, { recursive: true });
  await writeFile(join(dataRoot, "config.json"), JSON.stringify({ provider: "shared-api", model: "model-a", providers: [provider] }));
  try {
    const target = createUnifiedProviderSettingsMutationTarget({
      targetProviderFile: projection,
      unifiedConfigDataRoot: dataRoot,
      load: { dataRoot, includeProject: false, env: {} },
    });
    await target.deletePersonalModel("shared-api", "model-b");
    const editor = createProviderConfigEditor({ dataRoot, includeProject: false, env: {} });
    const afterModelDelete = await editor.read();
    assert.deepEqual(afterModelDelete.config.providers[0].models.map((model) => typeof model === "string" ? model : model.id), ["model-a"]);
    await target.deletePersonalProvider("shared-api");
    const afterProviderDelete = await editor.read();
    assert.deepEqual(afterProviderDelete.config.providers, []);
    const projectionText = await readFile(projection, "utf8");
    assert.doesNotMatch(projectionText, /shared-api/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function withTarget(
  run: (
    target: ReturnType<typeof createUnifiedProviderSettingsMutationTarget>,
    dataRoot: string,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "comecode-stale-snapshot-"));
  const dataRoot = join(root, "user");
  const projection = join(root, "runtime", "provider_config.json");
  await mkdir(dataRoot, { recursive: true });
  await writeFile(join(dataRoot, "config.json"), JSON.stringify({ providers: [provider] }));
  try {
    await run(
      createUnifiedProviderSettingsMutationTarget({
        targetProviderFile: projection,
        unifiedConfigDataRoot: dataRoot,
        load: { dataRoot, includeProject: false, env: {} },
      }),
      dataRoot,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("陈旧快照：删除已不存在的目标幂等成功而非报错", async () => {
  await withTarget(async (target, dataRoot) => {
    // 目标 Provider / Model 已被其它端删除：重复删除必须成功。
    await target.deletePersonalProvider("missing-provider");
    await target.deletePersonalModel("missing-provider", "missing-model");
    await target.deletePersonalModel("shared-api", "missing-model");
    const editor = createProviderConfigEditor({ dataRoot, includeProject: false, env: {} });
    const after = await editor.read();
    assert.deepEqual(
      after.config.providers.map((item) => item.id),
      ["shared-api"],
    );
  });
});

test("陈旧快照：非删除操作抛出可识别的过期错误", async () => {
  await withTarget(async (target) => {
    await assert.rejects(
      () => target.setPersonalModelEnabled("missing-provider", "model-a", false),
      (error: unknown) =>
        error instanceof ProviderMutationStaleError &&
        error.providerId === "missing-provider" &&
        error.availableProviderIds.includes("shared-api"),
    );
  });
});
