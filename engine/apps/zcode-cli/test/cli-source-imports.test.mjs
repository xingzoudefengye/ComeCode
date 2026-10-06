import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../node_modules/esbuild/lib/main.js";
import { createCliSourceImportsPlugin } from "../packages/cli/scripts/source-imports.mjs";

test("CLI打包优先当前TypeScript，外部JS与无源码JS保持原解析", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "comecode-source-imports-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, "src");
  await mkdir(src);
  await writeFile(
    join(src, "entry.ts"),
    'import {value} from "./value.js"; import {fallback} from "./fallback.js"; import {outside} from "../outside.js"; console.log(value, fallback, outside);',
  );
  await writeFile(join(src, "value.ts"), 'export const value = "current-source";');
  await writeFile(join(src, "value.js"), 'export const value = "stale-generated";');
  await writeFile(join(src, "fallback.js"), 'export const fallback = "js-only";');
  await writeFile(
    join(root, "outside.js"),
    'import {external} from "./external.js"; export const outside = external;',
  );
  await writeFile(join(root, "external.ts"), 'export const external = "external-ts-not-selected";');
  await writeFile(join(root, "external.js"), 'export const external = "external-js";');
  const result = await build({
    entryPoints: [join(src, "entry.ts")],
    bundle: true,
    write: false,
    plugins: [createCliSourceImportsPlugin(src)],
  });
  const text = result.outputFiles[0].text;
  assert.match(text, /current-source/u);
  assert.match(text, /js-only/u);
  assert.match(text, /external-js/u);
  assert.doesNotMatch(text, /stale-generated|external-ts-not-selected/u);
});
