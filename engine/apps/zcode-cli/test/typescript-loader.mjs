// 使用 TypeScript 的进程内转换运行源码测试，避免依赖 esbuild 子进程。
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import ts from "typescript";

function resolve(specifier, context, nextResolve) {
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    if (
      error.code !== "ERR_MODULE_NOT_FOUND" ||
      (!specifier.startsWith(".") && !specifier.startsWith("#src/")) ||
      !specifier.endsWith(".js")
    )
      throw error;
    try {
      return nextResolve(specifier.slice(0, -3) + ".ts", context);
    } catch (sourceError) {
      if (sourceError.code !== "ERR_MODULE_NOT_FOUND") throw sourceError;
      return nextResolve(specifier.slice(0, -3) + ".tsx", context);
    }
  }
}

function load(url, context, nextLoad) {
  if (!/\.tsx?$/u.test(url)) return nextLoad(url, context);
  const source = readFileSync(new URL(url), "utf8");
  return {
    format: "module",
    shortCircuit: true,
    source: ts.transpileModule(source, {
      fileName: new URL(url).pathname,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText,
  };
}
registerHooks({ resolve, load });
