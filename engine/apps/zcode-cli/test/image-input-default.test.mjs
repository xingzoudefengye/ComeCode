import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { materializeUnifiedConfig } from "../packages/adapters/src/config/provider-config-materialize.ts";

test("图片输入缺失默认支持，显式关闭保留，不覆盖窗口", async t => {
  const root = await mkdtemp(join(tmpdir(), "comecode-image-default-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "config.json"), JSON.stringify({ providers: [{ id: "fixture", type: "anthropic", apiKey: "fake-key", models: [
    { id: "default-image", contextWindow: 32000 }, { id: "no-image", vision: false }, { id: "yes-image", vision: true },
  ] }] }));
  const targetProviderFile = join(root, "runtime.json");
  await materializeUnifiedConfig({ dataRoot: root, cwd: root, env: {}, includeProject: false, targetProviderFile });
  const rules = JSON.parse(await readFile(targetProviderFile, "utf8")).config.modelConfigRules.providerModelRules;
  const properties = id => rules.find(r => r.modelId === id).config.properties;
  assert.equal(properties("default-image").inputFormat.supportsImage, true);
  assert.equal(properties("default-image").contextWindow, 32000);
  assert.equal(properties("no-image").inputFormat.supportsImage, false);
  assert.equal(properties("yes-image").inputFormat.supportsImage, true);
});
