import { stat } from "node:fs/promises";
import { dirname, relative, resolve, isAbsolute } from "node:path";

export function createCliSourceImportsPlugin(sourceRoot) {
  const root = resolve(sourceRoot);
  return {
    name: "comecode-cli-source-imports",
    setup(builder) {
      builder.onResolve({ filter: /\.js$/ }, async (args) => {
        if (!args.path.startsWith(".") || !args.importer) return;
        const importer = relative(root, args.importer);
        if (
          importer === ".." ||
          importer.startsWith("../") ||
          importer.startsWith("..\\") ||
          isAbsolute(importer)
        )
          return;
        // 源码旁的旧生成 JS 会盖过新命令；显式 .js 导入需要优先选择对应 TS。
        const base = resolve(dirname(args.importer), args.path.slice(0, -3));
        for (const extension of [".ts", ".tsx"]) {
          const path = base + extension;
          try {
            if ((await stat(path)).isFile()) return { path };
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
      });
    },
  };
}
