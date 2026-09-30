import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextBuilder } from "../packages/core/src/context/builder.ts";
import { buildProviderRequestMessages } from "../packages/core/src/runtime/helpers/provider-request-messages.ts";
import { getAutoCompactThreshold, shouldAutoCompact } from "../packages/core/src/compact/policy.ts";
import { toAiSdkTools } from "../packages/adapters/src/model/tool-transform.ts";
import {
  createGenerateTextOptions,
  createStreamTextOptions,
} from "../packages/adapters/src/model/runner-options.ts";
import { normalizeUsage } from "../packages/adapters/src/model/runner-normalization.ts";

const messages = [
  { role: "user", content: "first" },
  { role: "assistant", content: "answer" },
  { role: "user", content: "second" },
];
test("200K 默认在 120K 压缩，真实小窗口和输出预留优先", () => {
  assert.equal(getAutoCompactThreshold(), 120_000);
  assert.equal(getAutoCompactThreshold({ contextWindow: 128_000 }), 76_800);
  assert.equal(getAutoCompactThreshold({ contextWindow: 32_000 }), 0);
  assert.equal(
    getAutoCompactThreshold({ contextWindow: 32_000, maxOutputTokens: 4_000, bufferTokens: 1_000 }),
    19_200,
  );
  for (const contextWindow of [undefined, 0, -1, NaN, Infinity]) {
    assert.equal(getAutoCompactThreshold({ contextWindow }), 120_000);
  }
  for (const tokenCount of [119_999, 120_000]) {
    const decision = shouldAutoCompact({
      messages,
      tokenOverride: { source: "provider_usage", tokenCount },
    });
    assert.equal(decision.shouldCompact, tokenCount >= 120_000);
    assert.equal(decision.thresholdPercent, 60);
  }
});

test("显式百分比遵循安全预算，非法百分比回退，熔断与关闭仍有效", () => {
  assert.equal(getAutoCompactThreshold({ thresholdPercentOverride: 90 }), 166_000);
  assert.equal(getAutoCompactThreshold({ thresholdPercentOverride: 50 }), 100_000);
  for (const thresholdPercentOverride of [0, -1, 101, NaN, Infinity]) {
    assert.equal(getAutoCompactThreshold({ thresholdPercentOverride }), 120_000);
  }
  assert.equal(shouldAutoCompact({ messages, config: { enabled: false } }).reason, "disabled");
  assert.equal(shouldAutoCompact({ messages, consecutiveFailures: 3 }).reason, "circuit_breaker");
});

const makeTools = (reverse = false) => {
  const schema = reverse
    ? {
        properties: { z: { enum: ["b", "a"], type: "string" }, a: { type: "integer" } },
        type: "object",
        required: ["z", "a"],
      }
    : {
        required: ["z", "a"],
        type: "object",
        properties: { a: { type: "integer" }, z: { type: "string", enum: ["b", "a"] } },
      };
  const tools = [
    { name: "Read", description: "read", inputSchema: schema },
    { name: "Bash", description: "bash", inputSchema: schema },
  ];
  return reverse ? tools.reverse() : tools;
};
const options = (providerKind = "openai", sessionId = "parent", providerOptions) => ({
  includeModelIO: false,
  request: { messages, tools: makeTools(), providerOptions },
  resolved: { model: {}, modelId: "example", providerKind, properties: {} },
  statusContext: { sessionId },
});

test("流式与非流式缓存键按会话稳定、子会话隔离、显式值优先", () => {
  const stream = createStreamTextOptions(options());
  const generate = createGenerateTextOptions(options());
  assert.equal(stream.providerOptions.openai.promptCacheKey, "comecode:parent");
  assert.equal(
    generate.providerOptions.openai.promptCacheKey,
    stream.providerOptions.openai.promptCacheKey,
  );
  assert.equal(
    createStreamTextOptions(options("openai", "child")).providerOptions.openai.promptCacheKey,
    "comecode:child",
  );
  assert.equal(
    createStreamTextOptions(
      options("openai", "parent", { openai: { promptCacheKey: "custom", store: false } }),
    ).providerOptions.openai.promptCacheKey,
    "custom",
  );
  for (const providerKind of ["anthropic", "openai-compatible", "custom"]) {
    assert.equal(
      createStreamTextOptions(options(providerKind)).providerOptions?.openai?.promptCacheKey,
      undefined,
    );
  }
});

test("连续 10 轮 wire 工具和系统缓存前缀逐字一致，日期和新消息只在后缀变化", async () => {
  let prefix;
  let toolBytes;
  for (let turn = 0; turn < 10; turn++) {
    const context = new ContextBuilder({
      currentDate: `2026-09-${turn + 1}`,
      userInstructions: {
        content: "fixed project rules",
        filePath: "AGENTS.md",
        fileName: "AGENTS.md",
      },
      envInfo: {
        cwd: ".",
        platform: "test",
        shell: "test",
        osVersion: "test",
        nodeVersion: "test",
      },
    }).build();
    const projected = buildProviderRequestMessages({
      entries: [
        ...context.systemMessages,
        ...messages,
        { role: "user", content: `turn ${turn}` },
      ].map((message) => ({ message })),
      applyCacheControl: true,
    });
    const request = createStreamTextOptions({
      ...options(),
      request: { messages: projected.messages, tools: makeTools(turn % 2 === 0) },
    });
    const bytes = JSON.stringify(request.messages.filter((m) => m.role === "system"));
    const toolDefinitions = await Promise.all(
      Object.entries(request.tools).map(async ([name, tool]) => [
        name,
        tool.description,
        await tool.inputSchema.jsonSchema,
      ]),
    );
    const serializedTools = JSON.stringify(toolDefinitions);
    if (turn === 0) {
      prefix = bytes;
      toolBytes = serializedTools;
    }
    assert.equal(bytes, prefix);
    assert.equal(serializedTools, toolBytes);
    assert.ok(projected.messages.filter((m) => m.cacheControl).length <= 4);
  }
});

test("工具 canonical schema 不改调用方输入和数组语义", async () => {
  const tools = makeTools(true);
  const original = JSON.stringify(tools);
  const result = toAiSdkTools(tools);
  assert.deepEqual(Object.keys(result), ["Bash", "Read"]);
  const schema = await result.Read.inputSchema.jsonSchema;
  assert.deepEqual(schema.properties.z.enum, ["b", "a"]);
  assert.deepEqual(schema.required, ["z", "a"]);
  assert.equal(JSON.stringify(tools), original);
});

test("缓存统计采用 SDK 用量，raw 厂商字段仅补缺，不重复计入输入", () => {
  for (const raw of [
    { cache_read_input_tokens: 80, cache_creation_input_tokens: 10 },
    { prompt_tokens_details: { cached_tokens: 80 } },
    { prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 },
    { cachedContentTokenCount: 80 },
  ]) {
    const usage = normalizeUsage({ inputTokens: 100, raw });
    assert.equal(usage.inputTokens, 100);
    assert.equal(usage.cacheReadTokens, 80);
  }
  assert.equal(
    normalizeUsage({
      inputTokenDetails: { cacheReadTokens: 0 },
      raw: { prompt_cache_hit_tokens: 80 },
    }).cacheReadTokens,
    0,
  );
  assert.equal(normalizeUsage().cacheReadTokens, undefined);
});
