import assert from "node:assert/strict";
import { test } from "node:test";
import { recordMainTurnCacheHitUsage } from "../packages/core/src/runtime/methods/turn-model-step-usage.ts";

function createRuntime() {
  return {
    mainTurnCacheHitAggregate: {
      requestCount: 0,
      totalInputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
    },
  };
}

test("95% 用量样例按缓存读取除以总输入计算，写入和输出不算命中", () => {
  const runtime = createRuntime();
  const result = recordMainTurnCacheHitUsage(runtime, {
    inputTokens: 100_000,
    cacheReadTokens: 95_000,
    cacheWriteTokens: 3_000,
    outputTokens: 20_000,
    totalTokens: 120_000,
  });
  assert.equal(result.latestHitRate, 0.95);
  assert.equal(result.hitRate, 0.95);
  assert.equal(result.totalInputTokens, 100_000);
  assert.equal(result.totalCacheReadTokens, 95_000);
  assert.equal(result.totalCacheWriteTokens, 3_000);
});

test("冷启动保留在累计命中率内，不能用预热后单次 95% 宣称全会话达标", () => {
  const runtime = createRuntime();
  const cold = recordMainTurnCacheHitUsage(runtime, {
    inputTokens: 100_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 100_000,
  });
  assert.equal(cold.hitRate, 0);
  const warm = recordMainTurnCacheHitUsage(runtime, {
    inputTokens: 100_000,
    cacheReadTokens: 95_000,
    cacheWriteTokens: 0,
  });
  assert.equal(warm.latestHitRate, 0.95);
  assert.equal(warm.hitRate, 0.475);
  assert.equal(warm.hitRateRequestCount, 2);
});

test("大小请求使用 token 加权累计，不平均每次百分比", () => {
  const runtime = createRuntime();
  recordMainTurnCacheHitUsage(runtime, {
    inputTokens: 1_000,
    cacheReadTokens: 0,
  });
  const result = recordMainTurnCacheHitUsage(runtime, {
    inputTokens: 100_000,
    cacheReadTokens: 99_000,
  });
  assert.equal(result.hitRate, 99_000 / 101_000);
  assert.notEqual(result.hitRate, (0 + 0.99) / 2);
});
