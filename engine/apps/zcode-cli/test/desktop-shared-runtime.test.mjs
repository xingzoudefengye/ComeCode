import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ZCodeAgentProcessManager } from "../../../packages/services/src/zcode-agent/zcodeAgentProcessManager.ts";
import { ZCodeProtocolClient } from "../../../packages/services/src/zcode-agent/zcodeProtocolClient.ts";
import { ZCodeStdioTransport } from "../../../packages/services/src/zcode-agent/zcodeStdioTransport.ts";
import { acquireSessionWriterLease } from "../packages/adapters/src/storage/session-writer-lease.ts";
import { shouldEnableProviderAvailabilityLoginEntryGuard } from "../../../packages/ui/src/lib/rootStartupGate.ts";
import { createElectronDesktopContextPromptConfigFetcher } from "../../../packages/desktop/src/main/desktopContextPromptRollout.ts";
import { createSharedProviderSnapshot } from "../../../packages/services/src/model-provider/sharedProviderSnapshot.ts";
import { setDataBaseDir, getZCodeDataRootDir } from "../../../packages/services/src/paths.ts";

test("默认无需登录且厂商灰度配置不发起请求", async () => {
  assert.equal(shouldEnableProviderAvailabilityLoginEntryGuard(), false);
  const previous = process.env.ZCODE_ENDPOINT_ORIGIN;
  delete process.env.ZCODE_ENDPOINT_ORIGIN;
  try {
    const read = createElectronDesktopContextPromptConfigFetcher({
      appVersion: "0.0.0", deviceMid: "fake-device",
      resolveEndpointOrigin: () => { throw new Error("不应解析厂商端点"); },
    });
    assert.deepEqual(await read(new AbortController().signal), { code: 0, data: { configs: {} } });
  } finally {
    if (previous === undefined) delete process.env.ZCODE_ENDPOINT_ORIGIN;
    else process.env.ZCODE_ENDPOINT_ORIGIN = previous;
  }
});

test("Host 复用全局配置且派生快照不污染用户来源", async () => {
  const base = await mkdtemp(join(tmpdir(), "comecode-host-config-"));
  let snapshot;
  try {
    const root = join(base, ".comecode");
    await mkdir(root);
    const source = JSON.stringify({
      provider: "mock",
      model: "mock-model",
      providers: [
        {
          id: "mock",
          type: "openai-chat",
          baseUrl: "http://127.0.0.1:12345/v1",
          apiKey: "fake-key",
          models: ["mock-model"],
        },
      ],
    });
    await writeFile(join(root, "config.json"), source);
    setDataBaseDir(base);
    assert.equal(getZCodeDataRootDir(), root);
    snapshot = createSharedProviderSnapshot({ dataRoot: root, env: {} });
    await snapshot.prepare();
    const config = JSON.parse(await readFile(snapshot.filePath, "utf8"));
    assert.deepEqual(config.config.defaultModelSelection, {
      providerId: "mock",
      modelId: "mock-model",
    });
    assert.match(JSON.stringify(config), /fake-key/);
    assert.equal(await readFile(join(root, "config.json"), "utf8"), source);
    assert.notEqual(snapshot.filePath, join(root, "v2", "provider_config.json"));
  } finally {
    setDataBaseDir(null);
    await snapshot?.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

const entrypoint = fileURLToPath(new URL("../packages/cli/dist/zcode.cjs", import.meta.url));

function wireHostPreferences(client) {
  client.onRequest((request) => {
    if (request.method === "session/requestRuntimePreferences") {
      void client.respond(request.id, {
        askUserQuestionAutoResolutionEnabled: true,
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
      });
    }
  });
  return client;
}

async function sendTurn(client, sessionId, content) {
  await client.request("session/subscribe", { sessionId, deliveryKind: "desktop-continuous" });
  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error("mock turn timeout"));
    }, 30000);
    const subscription = client.onNotification((notification) => {
      if (notification.method !== "session/event") return;
      const event = notification.params?.event ?? notification.params;
      if (event.sessionId !== sessionId) return;
      if (event.type === "turn.completed" || event.type === "turn.failed") {
        clearTimeout(timeout);
        subscription.dispose();
        if (event.type === "turn.failed") reject(new Error(JSON.stringify(event.payload)));
        else resolve(event);
      }
    });
  });
  await client.request("session/send", { sessionId, content });
  await completed;
}

test(
  "实际 CLI stdio → Desktop Host manager → CLI 冷恢复继续，共用配置和 SQLite",
  { timeout: 120000 },
  async () => {
    const base = await mkdtemp(join(tmpdir(), "comecode-desktop-stdio-"));
    const requests = [];
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      assert.equal(request.headers.authorization, "Bearer fake-local-key");
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const content = `mock reply ${requests.length}`;
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", model: "mock-model", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`,
        );
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "mock",
            object: "chat.completion",
            model: "mock-model",
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
          }),
        );
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const workspacePath = join(base, "workspace");
    const workspace = { workspacePath, workspaceKey: workspacePath };
    const env = {
      ...process.env,
      COMECODE_DATA_BASE_DIR: base,
      ZCODE_DATA_BASE_DIR: base,
      ZCODE_STORAGE_DIR: join(base, ".comecode"),
      COMECODE_STORAGE_DIR: join(base, ".comecode"),
      ZCODE_SESSION_DB_PATH: join(base, ".comecode", "cli", "db", "db.sqlite"),
      ZCODE_LOAD_DOTENV: "0",
    };
    for (const key of Object.keys(env)) {
      if (
        /API_KEY|AUTH_TOKEN|PROVIDER_CONFIG_FILE|^COMECODE_(MODEL|PROVIDER)$|^OTEL_|^ZCODE_TELEMETRY_/u.test(
          key,
        )
      )
        delete env[key];
    }
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = join(base, "builtin.json");
    const transports = [];
    let manager;
    try {
      await mkdir(join(base, ".comecode"), { recursive: true });
      await mkdir(workspacePath);
      await writeFile(
        env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
        await readFile(new URL("../../../config/provider/zcode-builtin.json", import.meta.url)),
      );
      const configSource = JSON.stringify({
        provider: "mock",
        model: "mock-model",
        providers: [
          {
            id: "mock",
            type: "openai-chat",
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            apiKey: "fake-local-key",
            models: [{ id: "mock-model", contextWindow: 200000, toolCalling: true }],
          },
        ],
      });
      await writeFile(join(base, ".comecode", "config.json"), configSource);
      // 临时目录位于 HOME 下时，项目发现不能上溯到用户真实配置。
      await mkdir(join(workspacePath, ".comecode"));
      await writeFile(join(workspacePath, ".comecode", "config.json"), "{}");
      const startCli = () => {
        const child = spawn(process.execPath, [entrypoint, "app-server", "--stdio"], {
          cwd: workspacePath,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const transport = new ZCodeStdioTransport(child, {
          onStderrLine: (line) => process.stderr.write(`${line}\n`),
        });
        transports.push(transport);
        return {
          client: wireHostPreferences(
            new ZCodeProtocolClient(transport, { requestTimeoutMs: 30000 }),
          ),
          transport,
        };
      };
      const first = startCli();
      const created = await first.client.request("session/create", {
        workspace,
        titleGenerationEnabled: false,
      });
      const sessionId = created.session.sessionId;
      await sendTurn(first.client, sessionId, "CLI first turn");
      const competing = startCli();
      await assert.rejects(
        competing.client.request("session/resume", { workspace, sessionId }),
        /另一 CLI 或桌面进程/,
      );
      await competing.transport.disposeAndWait();
      await first.transport.disposeAndWait();
      manager = new ZCodeAgentProcessManager({
        requestTimeoutMs: 30000,
        commandResolver: () => ({
          command: process.execPath,
          args: [entrypoint, "app-server", "--stdio"],
          env,
        }),
      });
      const hostClient = wireHostPreferences(await manager.getClient({ workspacePath }));
      const resumed = await hostClient.request("session/resume", { workspace, sessionId });
      assert.match(JSON.stringify(resumed.messages), /CLI first turn/);
      assert.equal(resumed.settings.model.current.providerId, "mock");
      await sendTurn(hostClient, sessionId, "Desktop second turn");
      await manager.disposeAllAndWait();
      const last = startCli();
      const final = await last.client.request("session/resume", { workspace, sessionId });
      assert.match(JSON.stringify(final.messages), /Desktop second turn/);
      await sendTurn(last.client, sessionId, "CLI third turn");
      const persisted = await last.client.request("session/resume", { workspace, sessionId });
      assert.match(JSON.stringify(persisted.messages), /CLI first turn/);
      assert.match(JSON.stringify(persisted.messages), /Desktop second turn/);
      assert.match(JSON.stringify(persisted.messages), /CLI third turn/);
      assert.ok(requests.length >= 3);
      const lastRequest = JSON.stringify(requests.at(-1).messages);
      assert.match(lastRequest, /CLI third turn/);
    } finally {
      await manager?.disposeAllAndWait();
      for (const transport of transports) await transport.disposeAndWait();
      await new Promise((resolve) => server.close(resolve));
      await rm(base, { recursive: true, force: true });
    }
  },
);
test("会话 writer lease 拒绝并发写入、隔离会话并在释放后接管", async () => {
  const base = await mkdtemp(join(tmpdir(), "comecode-writer-lease-"));
  let release;
  let other;
  try {
    const dbPath = join(base, "db.sqlite");
    release = await acquireSessionWriterLease({ dbPath, sessionId: "session-a" });
    await assert.rejects(acquireSessionWriterLease({ dbPath, sessionId: "session-a" }), {
      code: "COMECODE_SESSION_WRITER_BUSY",
    });
    other = await acquireSessionWriterLease({ dbPath, sessionId: "session-b" });
    await release();
    release = await acquireSessionWriterLease({ dbPath, sessionId: "session-a" });
  } finally {
    await release?.();
    await other?.();
    await rm(base, { recursive: true, force: true });
  }
});

test("Host 统一配置非法时明确失败，不覆盖来源", async () => {
  const base = await mkdtemp(join(tmpdir(), "comecode-host-invalid-"));
  const snapshot = createSharedProviderSnapshot({ dataRoot: base, env: {} });
  try {
    await writeFile(join(base, "config.json"), "{broken");
    await assert.rejects(snapshot.prepare());
    assert.equal(await readFile(join(base, "config.json"), "utf8"), "{broken");
  } finally {
    await snapshot.dispose();
    await rm(base, { recursive: true, force: true });
  }
});
