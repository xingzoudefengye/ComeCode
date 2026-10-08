import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseGlobalArgs } from "../packages/cli/src/arguments.ts";
import { formatCliHelp } from "../packages/cli/src/help.ts";
import { isTuiInvocation } from "../packages/cli/src/tui-stderr.ts";
import { resolveWebRuntime, runWebCommand } from "../packages/cli/src/web-command.ts";

// runWebCommand 只读取 stderr 输出；stdin/stdout 在“缺少运行时”路径上不会被触碰。
function context() {
  const stderr = [];
  return {
    ctx: {
      argv: [],
      stderr: { write: (chunk) => (stderr.push(String(chunk)), true) },
      stdin: process.stdin,
      stdout: process.stdout,
    },
    stderr,
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "comecode-web-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

/** 安装包布局：web/、server/、comecode.cjs 与可选 agent/ 同级。 */
async function packagedLayout(root, { withAgent }) {
  await mkdir(join(root, "web"), { recursive: true });
  await writeFile(join(root, "web", "index.html"), "<html></html>");
  await mkdir(join(root, "server"), { recursive: true });
  await writeFile(join(root, "server", "entry-http.js"), "// entry-http");
  await writeFile(join(root, "comecode.cjs"), "// cli");
  if (withAgent) {
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(join(root, "agent", "zcode.cjs"), "// agent");
  }
}

test("--web 不再被当作 TUI 调用，默认命令仍是 TUI", () => {
  assert.equal(isTuiInvocation(["--web"]), false);
  assert.equal(isTuiInvocation(["--web", "--no-browser"]), false);
  assert.equal(isTuiInvocation([]), true);
  assert.equal(isTuiInvocation(["--no-browser"]), true);
});

test("--no-web 已移除，--port 与 --web-port 都是合法端口参数", () => {
  assert.throws(() => parseGlobalArgs(["--no-web"]));
  assert.equal(parseGlobalArgs(["--port", "8080"]).values.port, "8080");
  assert.equal(parseGlobalArgs(["--web-port", "8080"]).values["web-port"], "8080");
  assert.equal(parseGlobalArgs(["--web"]).values.web, true);
});

test("帮助文案区分网页对话与管理后台，且不再宣传 --no-web", () => {
  const help = formatCliHelp("1.2.3");
  assert.match(help, /comecode --web/u);
  assert.match(help, /comecode admin/u);
  assert.doesNotMatch(help, /--no-web/u);
});

test("resolveWebRuntime 优先使用打包布局，并在缺 agent 入口时回落到 CLI 自身", async (t) => {
  const root = await fixture(t);
  const packaged = join(root, "comecode-1.0.0-win-x64");
  await packagedLayout(packaged, { withAgent: true });
  const savedArgv1 = process.argv[1];
  process.argv[1] = join(packaged, "comecode.cjs");
  try {
    const runtime = await resolveWebRuntime();
    assert.equal(runtime?.staticRoot, join(packaged, "web"));
    assert.equal(runtime?.serverEntry, join(packaged, "server", "entry-http.js"));
    assert.equal(runtime?.agentEntry, join(packaged, "agent", "zcode.cjs"));
  } finally {
    process.argv[1] = savedArgv1;
  }

  const withoutAgent = join(root, "comecode-1.0.0-win-x64b");
  await packagedLayout(withoutAgent, { withAgent: false });
  process.argv[1] = join(withoutAgent, "comecode.cjs");
  try {
    const runtime = await resolveWebRuntime();
    assert.equal(runtime?.agentEntry, join(withoutAgent, "comecode.cjs"));
  } finally {
    process.argv[1] = savedArgv1;
  }
});

test("缺少 web/server 资源时返回失败并给出构建指引", async (t) => {
  const root = await fixture(t);
  const savedCwd = process.cwd();
  const savedArgv1 = process.argv[1];
  // 切到没有任何 web/server 的临时目录，避免仓库内的构建产物让解析意外成功。
  process.chdir(root);
  process.argv[1] = join(root, "comecode.cjs");
  await writeFile(join(root, "comecode.cjs"), "// cli");
  try {
    const { ctx, stderr } = context();
    const code = await runWebCommand(ctx, {});
    assert.equal(code, 1);
    assert.match(stderr.join(""), /未找到网页对话运行时/u);
  } finally {
    process.chdir(savedCwd);
    process.argv[1] = savedArgv1;
  }
});
