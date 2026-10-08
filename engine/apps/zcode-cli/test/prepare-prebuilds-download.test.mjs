import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS,
  download,
  downloadWithRetry,
  resolveDownloadStallTimeoutMs,
} from "../../../scripts/prepare-prebuilds.mjs";

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-prebuild-download-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: (pathname) => `http://127.0.0.1:${port}${pathname}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function captureWarnings(run) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await run();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

test("正常路径：分块响应完整落盘", async () => {
  const { url, close } = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write("part-1|");
    setTimeout(() => response.end("part-2"), 30);
  });

  try {
    await withTempDir(async (dir) => {
      const target = join(dir, "node.tar.xz");
      await download(url("/node.tar.xz"), target, { stallTimeoutMs: 1_000 });
      assert.equal(await readFile(target, "utf8"), "part-1|part-2");
    });
  } finally {
    await close();
  }
});

test("失败路径：对端不返回任何响应时按无进展中止，不再无限等待", async () => {
  // 复现 CI 事故：CDN 接受连接后既不返回响应头也不返回数据，fetch 既不 resolve 也不 reject。
  const { url, close } = await startServer(() => {});

  try {
    await withTempDir(async (dir) => {
      const startedAt = Date.now();
      await assert.rejects(
        download(url("/hang"), join(dir, "hang.tar.xz"), { stallTimeoutMs: 300 }),
        /stalled|abort/i,
      );
      assert.ok(
        Date.now() - startedAt < 10_000,
        "看门狗超时后应立即失败，而不是等到 job 级超时",
      );
    });
  } finally {
    await close();
  }
});

test("失败路径：传输中途挂死（已收到部分字节）同样能中止", async () => {
  const { url, close } = await startServer((_request, response) => {
    response.writeHead(200, { "content-length": "1048576" });
    response.write("partial-payload");
    // 之后不再写入，也不结束响应。
  });

  try {
    await withTempDir(async (dir) => {
      await assert.rejects(
        download(url("/stall"), join(dir, "stall.tar.xz"), { stallTimeoutMs: 300 }),
        /stalled|abort/i,
      );
    });
  } finally {
    await close();
  }
});

test("兼容路径：首次挂死会重试，并在第二次恢复", async () => {
  let attempts = 0;
  const { url, close } = await startServer((_request, response) => {
    attempts += 1;
    if (attempts === 1) {
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end("recovered");
  });

  try {
    await withTempDir(async (dir) => {
      const target = join(dir, "retry.tar.xz");
      const warnings = await captureWarnings(() =>
        downloadWithRetry(url("/retry"), target, { maxAttempts: 2, stallTimeoutMs: 300 }),
      );
      assert.equal(await readFile(target, "utf8"), "recovered");
      assert.equal(attempts, 2);
      assert.ok(
        warnings.some((warning) => warning.includes("download attempt 1/2 failed")),
        "重试时应打印告警",
      );
    });
  } finally {
    await close();
  }
});

test("失败路径：非 2xx 响应直接失败且不写入内容", async () => {
  const { url, close } = await startServer((_request, response) => {
    response.writeHead(503, { "content-type": "text/plain" });
    response.end("unavailable");
  });

  try {
    await withTempDir(async (dir) => {
      await assert.rejects(
        downloadWithRetry(url("/missing"), join(dir, "missing.tar.xz"), { maxAttempts: 1 }),
        /HTTP 503/,
      );
    });
  } finally {
    await close();
  }
});

test("兼容路径：无进展上限默认 60s，可被环境变量覆盖并在非法值时回落默认值", () => {
  assert.equal(DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS, 60_000);
  assert.equal(resolveDownloadStallTimeoutMs({}), DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS);
  assert.equal(
    resolveDownloadStallTimeoutMs({ ZCODE_DOWNLOAD_STALL_TIMEOUT_MS: " 1500 " }),
    1_500,
  );
  for (const invalid of ["", "abc", "0", "-1"]) {
    assert.equal(
      resolveDownloadStallTimeoutMs({ ZCODE_DOWNLOAD_STALL_TIMEOUT_MS: invalid }),
      DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS,
      `非法值 ${JSON.stringify(invalid)} 应回落默认值`,
    );
  }
});
