import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { offerLegacyDataImport } from "../packages/cli/src/legacy-data-import.ts";

for (const scenario of ["同意", "拒绝", "非交互", "显式路径"]) {
  test(`旧数据导入：${scenario}`, async () => {
    const home = await mkdtemp(join(tmpdir(), "comecode-import-"));
    try {
      await mkdir(join(home, ".zcode"));
      await writeFile(join(home, ".zcode", "sample.json"), "{}");
      let confirmations = 0;
      await offerLegacyDataImport({
        env: scenario === "显式路径" ? { COMECODE_DATA_BASE_DIR: home } : {},
        home,
        interactive: scenario !== "非交互",
        stderr: { write() {} },
        confirm: async () => {
          confirmations++;
          return scenario === "同意";
        },
      });
      assert.equal(confirmations, scenario === "非交互" || scenario === "显式路径" ? 0 : 1);
      assert.equal(await readFile(join(home, ".zcode", "sample.json"), "utf8"), "{}");
      if (scenario === "同意") {
        assert.equal(await readFile(join(home, ".comecode", "sample.json"), "utf8"), "{}");
        await offerLegacyDataImport({
          env: {},
          home,
          interactive: true,
          stderr: { write() {} },
          confirm: async () => {
            throw new Error("不应重复提示");
          },
        });
      } else {
        await assert.rejects(stat(join(home, ".comecode")), { code: "ENOENT" });
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}
