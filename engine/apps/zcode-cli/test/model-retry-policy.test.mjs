import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAiSdkModelRetryOptions } from "../packages/adapters/src/model/retry-policy.ts";

test("模型默认最多重试 5 次，显式配置和环境变量仍可覆盖", () => {
  assert.equal(resolveAiSdkModelRetryOptions(undefined, {}).maxAttempts, 6);
  assert.equal(
    resolveAiSdkModelRetryOptions(undefined, { ZCODE_MODEL_RETRY_MAX_RETRIES: "2" }).maxAttempts,
    3,
  );
  assert.equal(resolveAiSdkModelRetryOptions({ maxAttempts: 4 }, {}).maxAttempts, 4);
});
