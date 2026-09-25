import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import wasmModule from "@jitl/quickjs-wasmfile-release-sync/wasm";
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
