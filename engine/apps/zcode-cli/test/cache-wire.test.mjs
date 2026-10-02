import assert from "node:assert/strict";
import { test } from "node:test";
import { generateText, streamText } from "ai";
import { AiSdkModelExecution } from "../packages/adapters/src/model/model-execution.ts";
import { createGenerateTextOptions, createStreamTextOptions } from "../packages/adapters/src/model/runner-options.ts";
import { ContextBuilder } from "../packages/core/src/context/builder.ts";
import { buildProviderRequestMessages } from "../packages/core/src/runtime/helpers/provider-request-messages.ts";

const protocols = [
  ["openai-responses", "/responses"],
  ["openai-chat-completions", "/chat/completions"],
  ["anthropic-messages", "/messages"],
];
const tools = [
  { name: "Read", description: "Read a project file", inputSchema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
];
const largeHistory = Array.from({ length: 4_000 }, (_, index) => `Project fixture fact ${index}: retain the verified behavior.\n`).join("");

function withoutCacheMarkers(value) {
  if (Array.isArray(value)) return value.map(withoutCacheMarkers);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, child]) => [key, withoutCacheMarkers(child)]));
  }
  return value;
}

function countBreakpoints(value) {
  if (Array.isArray(value)) return value.reduce((sum, child) => sum + countBreakpoints(child), 0);
  if (!value || typeof value !== "object") return 0;
  return Object.entries(value).reduce((sum, [key, child]) => sum + (key === "cache_control" ? 1 : countBreakpoints(child)), 0);
}

for (const [protocol, endpoint] of protocols) {
  for (const streaming of [false, true]) {
    test(`${protocol} ${streaming ? "stream" : "generate"}: 最终 HTTP 十轮大历史旧前缀稳定（本地拒绝响应，不验证服务端命中）`, async () => {
      const captured = [];
      const execution = new AiSdkModelExecution({ env: {} }, {
        transport: async (url, init) => {
          assert.equal(new URL(String(url)).hostname, "cache.example");
          assert.ok(new URL(String(url)).pathname.endsWith(endpoint));
          captured.push(JSON.parse(init.body));
          // 请求已到最终传输边界；拒绝响应避免模拟成功用量被误作真实命中证据。
          return new Response(JSON.stringify({ error: { message: "local request capture", type: "invalid_request_error" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        },
      });
      const { resolved: base } = execution.bindModel({
        providerId: "fixture",
        modelId: "fixture-model",
        supportsJsonSchemaOutput: false,
        optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
        providerConfig: {
          api: { type: protocol, baseUrl: "https://cache.example/v1" },
          access: { type: "api-key", apiKey: "fixture-not-a-real-key" },
        },
      });
      const resolved = { ...base, properties: {} };
      const context = new ContextBuilder({
        currentDate: "2026-10-02",
        userInstructions: { content: "Fixed project rules", filePath: "AGENTS.md", fileName: "AGENTS.md" },
        envInfo: { cwd: ".", platform: "test", shell: "test", osVersion: "test", nodeVersion: "test" },
      }).build();
      const entries = [
        ...context.systemMessages.map((message) => ({ message })),
        ...context.metaUserAttachments.map((attachment) => ({ kind: "attachment", content: attachment.content, metadata: { source: attachment.source } })),
        { message: { role: "user", content: largeHistory }, metadata: { source: "real_user" } },
      ];
      let previous;
      let stable;
      async function capture(sessionId, providerOptions) {
        const input = {
          includeModelIO: false,
          request: { messages: buildProviderRequestMessages({ entries, applyCacheControl: true }).messages, tools, providerOptions },
          resolved,
          statusContext: { sessionId },
        };
        const before = captured.length;
        if (streaming) {
          const result = streamText({ ...createStreamTextOptions(input), onError: () => {} });
          const errors = [];
          for await (const part of result.fullStream) if (part.type === "error") errors.push(part.error);
          assert.equal(errors.length, 1);
        } else {
          await assert.rejects(generateText(createGenerateTextOptions(input)));
        }
        assert.equal(captured.length, before + 1, "一次调用只发送一次，不额外预热或重试");
        return captured.at(-1);
      }
      for (let turn = 0; turn < 10; turn += 1) {
        if (turn > 0) {
          entries.push({ message: { role: "assistant", content: `Reading file ${turn}`, toolCalls: [{ id: `read-${turn}`, name: "Read", input: { file_path: `file-${turn}.ts` } }] } });
          entries.push({ message: { role: "tool", content: `File result ${turn}`, toolCallId: `read-${turn}`, toolName: "Read" } });
          // 构造追加 guide 内容，只验序列化，不等同于完整 runtime guide 投递验收。
          entries.push({ message: { role: "user", content: `Guide: continue step ${turn}` }, metadata: { source: "real_user" } });
        }
        const body = await capture("parent");
        assert.equal(body.model, "fixture-model");
        assert.equal(body.stream === true, streaming);
        if (protocol === "openai-responses" || protocol === "openai-chat-completions") {
          assert.equal(body.prompt_cache_key, "comecode:parent");
        }
        if (protocol === "anthropic-messages") {
          assert.ok(countBreakpoints(body) > 0);
          assert.ok(countBreakpoints(body) <= 4);
          assert.deepEqual(body.messages.at(-1).content.at(-1).cache_control, { type: "ephemeral" });
        }
        const prefix = JSON.stringify({ tools: body.tools, system: body.system });
        if (stable !== undefined) assert.equal(prefix, stable);
        stable = prefix;
        const conversation = withoutCacheMarkers(body.input ?? body.messages);
        if (previous) assert.deepEqual(conversation.slice(0, previous.length), previous);
        assert.ok(JSON.stringify(conversation).includes("Project fixture fact 3999"));
        previous = conversation;
      }
      if (protocol === "openai-responses") {
        assert.equal((await capture("child")).prompt_cache_key, "comecode:child");
        assert.equal((await capture("parent", { openai: { promptCacheKey: "explicit" } })).prompt_cache_key, "explicit");
      }
    });
  }
}
