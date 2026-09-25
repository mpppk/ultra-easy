import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
// package exportsの"./wasm"は拡張子を持たずwranglerのwasm module ruleに一致しないため、
// 依存packageのwasm fileを直接参照する（wranglerがWebAssembly.Moduleとしてbundleする）。
import wasmModule from "../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm";
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";

let cached: Promise<QuickJSWASMModule> | undefined;

/**
 * Cloudflare Workers（workerd）での読み込み。Workersは実行時のwasm compileを許さないため、
 * wranglerがbundleした`WebAssembly.Module`をvariantへ注入する。
 */
export function workerdQuickJsModule(): Promise<QuickJSWASMModule> {
  cached ??= newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmModule }));
  return cached;
}
