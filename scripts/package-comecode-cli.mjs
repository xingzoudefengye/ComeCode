import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  collectSeaTuiAssets,
  seaTuiAssetPrefix,
} from "../engine/apps/zcode-cli/packages/cli/scripts/sea-tui-assets.mjs";
import {
  collectSeaPlaywrightAssets,
  seaPlaywrightAssetPrefix,
} from "../engine/apps/zcode-cli/packages/cli/scripts/sea-playwright-assets.mjs";
import {
  collectSeaBundledSkillAssets,
  seaBundledSkillAssetPrefix,
} from "../engine/apps/zcode-cli/packages/cli/scripts/sea-bundled-skill-assets.mjs";
import {
  collectSeaOfficialPluginAssets,
  officialSeaPlugins,
  seaOfficialPluginAssetPrefix,
} from "../engine/apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs";
import { hostTarget } from "../engine/apps/zcode-cli/packages/cli/scripts/sea-targets.mjs";

const execFile = promisify(execFileCallback);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
async function runPnpm(args, options) {
  if (process.platform === "win32") {
    return execFile(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `pnpm ${args.join(" ")}`], options);
  }
  return execFile(pnpmCommand, args, options);
}
async function npmPack(cwd) {
  const args = ["pack", "--pack-destination", output];
  return execFile(npmCommand, args, {
    cwd,
    shell: process.platform === "win32",
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });
}
const root = resolve(import.meta.dirname, "..");
const engine = join(root, "engine");
const cli = join(engine, "apps/zcode-cli");
const output = join(root, "artifacts/comecode");
const tar =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32/tar.exe")
    : "tar";
const target = hostTarget();
const version = JSON.parse(await readFile(join(cli, "package.json"), "utf8")).version;
if (!/^[\w.-]+$/u.test(version)) throw new Error("Invalid CLI version");
const name = `comecode-${version}-${target.replace(/^win-/u, "windows-")}`;
const work = await mkdtemp(join(tmpdir(), "comecode-package-"));
const stage = join(work, name);
const provider = join(cli, "packages/cli/dist/provider/zcode-builtin.json");

// 只审查凭据字段，不打印内容；使用白名单资源收集器，避免复制工作区或个人配置。
export function assertNoCredentials(value) {
  if (Array.isArray(value)) {
    for (const child of value) assertNoCredentials(child);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (
        /^(api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|authorization)$/iu.test(
          key,
        ) &&
        child != null &&
        child !== ""
      ) {
        throw new Error("Distribution contains a credential field");
      }
      assertNoCredentials(child);
    }
  }
}

async function addBundledDependencies(packageDirectory) {
  const dependenciesDirectory = join(packageDirectory, "node_modules");
  const dependencies = {};
  const bundledDependencies = [];
  for (const entry of await readdir(dependenciesDirectory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const packageDirectories = entry.name.startsWith("@")
      ? (await readdir(join(dependenciesDirectory, entry.name), { withFileTypes: true }))
          .filter((child) => child.isDirectory())
          // npm 只认正斜杠的 scoped 包名；用 path.join 会得到 @scope\name 并被当作非法 bundledDependency 丢弃。
          .map((child) => `${entry.name}/${child.name}`)
      : [entry.name];
    for (const packageName of packageDirectories) {
      const metadata = JSON.parse(await readFile(join(dependenciesDirectory, packageName, "package.json"), "utf8"));
      dependencies[packageName] = metadata.version;
      bundledDependencies.push(packageName);
    }
  }
  const packageFile = join(packageDirectory, "package.json");
  const packageJson = JSON.parse(await readFile(packageFile, "utf8"));
  packageJson.dependencies = dependencies;
  packageJson.bundledDependencies = bundledDependencies;
  await writeFile(packageFile, JSON.stringify(packageJson, null, 2) + "\n");
}

async function copy(source, destination, mode) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  if (mode) await chmod(destination, mode);
}

async function copyAssets(result, prefix, destination) {
  for (const [key, source] of Object.entries(result.assets)) {
    const path = key.slice(prefix.length);
    if (
      [
        "manifest.json",
        "playwright-manifest.json",
        "bundled-skills-manifest.json",
        "official-plugins-manifest.json",
      ].includes(path)
    )
      continue;
    if (
      path.endsWith(".map") ||
      path.split("/").some((part) => part === ".env" || part.startsWith(".env."))
    )
      continue;
    await copy(source, join(destination, path));
  }
}

try {
  assertNoCredentials(JSON.parse(await readFile(provider, "utf8")));
  await mkdir(stage, { recursive: true });
  await copy(join(cli, "packages/cli/dist/zcode.cjs"), join(stage, "comecode.cjs"), 0o755);
  await copy(provider, join(stage, "provider/zcode-builtin.json"));
  for (const file of ["LICENSE", "NOTICE.md", "THIRD-PARTY-NOTICES.md"]) {
    await copy(join(engine, file), join(stage, file));
  }
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify(
      {
        name: `comecode-runtime-${target}`,
        version,
        description: "ComeCode platform runtime",
        license: "Apache-2.0",
        repository: {
          type: "git",
          url: "https://github.com/xingzoudefengye/ComeCode.git",
        },
        engines: { node: ">=24.14.0" },
        os: [process.platform],
        cpu: [process.arch],
        files: ["**/*"],
      },
      null,
      2,
    ) + "\n",
  );
  await copyAssets(
    await collectSeaTuiAssets({ root: cli, target, stagingDirectory: join(work, "tui") }),
    seaTuiAssetPrefix,
    stage,
  );
  await copyAssets(
    await collectSeaPlaywrightAssets({
      root: cli,
      target,
      stagingDirectory: join(work, "playwright"),
    }),
    seaPlaywrightAssetPrefix,
    stage,
  );
  await copyAssets(
    await collectSeaBundledSkillAssets({ root: cli, stagingDirectory: join(work, "skills") }),
    seaBundledSkillAssetPrefix,
    join(stage, "packages/bundled-skills"),
  );
  const plugins = await collectSeaOfficialPluginAssets({
    root: cli,
    requireRuntime: true,
    stagingDirectory: join(work, "plugins"),
  });
  for (const plugin of officialSeaPlugins) {
    const prefix = `${seaOfficialPluginAssetPrefix}${plugin.marketplace}/${plugin.name}/${plugin.version}/`;
    await copyAssets(
      {
        assets: Object.fromEntries(
          Object.entries(plugins.assets).filter(([key]) => key.startsWith(prefix)),
        ),
      },
      prefix,
      join(stage, plugin.rootPath),
    );
  }
  await addBundledDependencies(stage);
  await writeFile(
    join(stage, "DISTRIBUTION.txt"),
    `ComeCode ${version}, ${target}\nRequires external Node.js 24.14.0 or newer Node 24.\nRun: node comecode.cjs --help\nKeep node_modules, provider and packages alongside comecode.cjs.\nThis is not a standalone executable. Native dependencies are OS/CPU specific.\nLinux requires glibc; browser binaries, signing and notarization are not included.\n`,
  );
  await mkdir(output, { recursive: true });
  await npmPack(stage);
  const runtimePackage = (await readdir(output)).find((file) => file.startsWith("comecode-runtime-") && file.endsWith(".tgz"));
  if (!runtimePackage) throw new Error("npm did not produce a runtime package");
  const entryStage = join(work, "entry");
  // 平台矩阵中只允许一个任务产出入口包，否则同名资产会在 Release 上冲突。
  if (process.env.COMECODE_SKIP_NPM_ENTRY !== "1") {
    await mkdir(entryStage, { recursive: true });
    await copy(join(root, "scripts/comecode-entry.cjs"), join(entryStage, "comecode.cjs"), 0o755);
    await copy(join(engine, "LICENSE"), join(entryStage, "LICENSE"));
    await writeFile(
      join(entryStage, "package.json"),
      JSON.stringify(
        {
          name: "comecode",
          version,
          description: "ComeCode - vendor-neutral open-source coding agent",
          license: "Apache-2.0",
          repository: { type: "git", url: "https://github.com/xingzoudefengye/ComeCode.git" },
          bin: { comecode: "./comecode.cjs" },
          engines: { node: ">=24.14.0" },
          optionalDependencies: {
            "comecode-runtime-linux-x64": version,
            "comecode-runtime-win-x64": version,
            "comecode-runtime-darwin-arm64": version,
          },
        },
        null,
        2,
      ) + "\n",
    );
    await npmPack(entryStage);
  }
  const archive = join(output, `${name}.tar.gz`);
  await execFile(tar, ["-czf", archive, "-C", work, name]);
  // 从实际归档解包，再在系统临时目录运行，不能借用仓库 node_modules 掩盖缺依赖。
  const extracted = join(work, "extracted");
  await mkdir(extracted);
  await execFile(tar, ["-xzf", archive, "-C", extracted]);
  const unpacked = join(extracted, name);
  const env = {
    ...process.env,
    NODE_PATH: "",
    ZCODE_DATA_BASE_DIR: join(work, "data"),
    COMECODE_DATA_BASE_DIR: join(work, "data"),
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(unpacked, "provider/zcode-builtin.json"),
  };
  const options = { cwd: unpacked, env, timeout: 60000, maxBuffer: 10 * 1024 * 1024 };
  for (const flag of ["--help", "--licenses"]) {
    const { stdout } = await execFile(
      process.execPath,
      [join(unpacked, "comecode.cjs"), flag],
      options,
    );
    if (!stdout.trim()) throw new Error(`Empty ${flag} output`);
  }
  await execFile(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'await import("@zcode/tui"); await import("@mbears/opentui-core"); const k = await import("koffi"); (k.default ?? k).load(process.platform === "win32" ? "kernel32.dll" : process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6"); await import("playwright-core");',
    ],
    options,
  );
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(`${archive}.sha256`, `${digest}  ${name}.tar.gz\n`);
  console.log(`Packaged and isolated-smoke-tested ${archive}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
