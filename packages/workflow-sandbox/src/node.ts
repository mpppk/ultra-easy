import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";

let cached: Promise<QuickJSWASMModule> | undefined;

/** Node / Vitestでの読み込み（wasmはvariantがfileから読む）。isolate内で1回だけ初期化する。 */
export function nodeQuickJsModule(): Promise<QuickJSWASMModule> {
  cached ??= newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
  return cached;
}
