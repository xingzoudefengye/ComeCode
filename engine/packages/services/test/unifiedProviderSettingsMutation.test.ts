import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUnifiedProviderSettingsMutationTarget } from "../src/model-provider/unifiedProviderSettingsMutation.js";
import { createProviderConfigEditor } from "@zcode/adapters/config";

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
