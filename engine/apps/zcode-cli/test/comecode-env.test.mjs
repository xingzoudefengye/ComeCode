import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  normalizeComeCodeEnv,
  resolveComeCodeDataRoot,
} from "../packages/adapters/dist/config/comecode-env.js";
import { parseEnvConfig } from "../packages/adapters/dist/config/env-config.adapter.js";
import { createConfig } from "../packages/adapters/dist/config/index.js";
import { resolveSharedZCodeCredentialsPath } from "../packages/adapters/dist/auth/shared-credentials.js";
import { createNodeLoggerFactory } from "../packages/adapters/dist/logging/index.js";

test("新前缀优先且保留旧前缀与显式空值", () => {
  const env = normalizeComeCodeEnv({
    ZCODE_HTTP_PROXY: "old",
    COMECODE_HTTP_PROXY: "",
    COMECODE_LOG_FORMAT: "json",
  });
  assert.equal(env.ZCODE_HTTP_PROXY, "");
  assert.equal(env.ZCODE_LOG_FORMAT, "json");
  assert.equal(normalizeComeCodeEnv({ ZCODE_HTTP_PROXY: "old" }).ZCODE_HTTP_PROXY, "old");
  assert.equal(parseEnvConfig(env).network.httpProxy, "");
  assert.equal(
    parseEnvConfig({ COMECODE_STORAGE_DIR: "new", ZCODE_STORAGE_DIR: "old" }).storage.dir,
    "new",
  );
  assert.equal(
    parseEnvConfig({ CUSTOM_STORAGE_DIR: "custom" }, { prefix: "CUSTOM_" }).storage.dir,
    "custom",
  );
});

test("配置、会话、日志与凭据使用同一隔离数据根", () => {
  const env = { COMECODE_DATA_BASE_DIR: "isolated" };
  const root = join(resolve("isolated"), ".comecode");
  const result = createConfig({ env, skipUserConfig: true });
  assert.equal(result.sources.user.path, join(root, "cli", "config.json"));
  assert.equal(result.config.storage.dir, root);
  assert.equal(result.config.storage.sessionDbPath, join(root, "cli", "db", "db.sqlite"));
  assert.equal(resolveSharedZCodeCredentialsPath({ env }), join(root, "v2", "credentials.json"));
  assert.equal(createNodeLoggerFactory({ env }).getLogDir(), join(root, "cli", "log"));
});

test("数据父目录优先级、空白和 tilde 展开", () => {
  assert.equal(resolveComeCodeDataRoot({}), join(homedir(), ".comecode"));
  assert.equal(
    resolveComeCodeDataRoot({ COMECODE_DATA_BASE_DIR: "new", ZCODE_DATA_BASE_DIR: "old" }),
    join(resolve("new"), ".comecode"),
  );
  assert.equal(
    resolveComeCodeDataRoot({ ZCODE_DATA_BASE_DIR: "old" }),
    join(resolve("old"), ".comecode"),
  );
  assert.equal(
    resolveComeCodeDataRoot({ COMECODE_DATA_BASE_DIR: "  ", ZCODE_DATA_BASE_DIR: "~/test" }),
    join(homedir(), "test", ".comecode"),
  );
});

test("setting.json 的自定义 dataBaseDir 与桌面 bootstrap 对齐", () => {
  const home = mkdtempSync(join(tmpdir(), "comecode-home-"));
  const custom = mkdtempSync(join(tmpdir(), "comecode-custom-"));
  mkdirSync(join(home, ".comecode", "v2"), { recursive: true });
  writeFileSync(
    join(home, ".comecode", "v2", "setting.json"),
    JSON.stringify({ dataBaseDir: custom }),
  );
  try {
    // 未设置任何数据目录 env 时，回退 setting.json，保证与桌面读写同一份 config.json。
    assert.equal(resolveComeCodeDataRoot({ HOME: home }), join(resolve(custom), ".comecode"));
    // env 显式数据目录优先于 setting.json。
    assert.equal(
      resolveComeCodeDataRoot({ HOME: home, ZCODE_DATA_BASE_DIR: "~" }),
      join(homedir(), ".comecode"),
    );
    // 显式构造的隔离 env（无 HOME）不读盘，保持纯函数语义。
    assert.equal(resolveComeCodeDataRoot({}), join(homedir(), ".comecode"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(custom, { recursive: true, force: true });
  }
});
