import { defineConfig } from "tsup";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const kfdAgentRuntimeVerifierWasmBase64 = fs
  .readFileSync(require.resolve("@kungfu-tech/kfd-agent-runtime/verifier/wasm"))
  .toString("base64");

export default defineConfig({
  target: "node24",
  platform: "node",
  banner: {
    js: "import { createRequire as __buildchainCreateRequire } from 'node:module';\nconst require = __buildchainCreateRequire(import.meta.url);",
  },
  splitting: false,
  sourcemap: false,
  minify: true,
  clean: true,
  outDir: "dist",
  skipNodeModulesBundle: false,
  noExternal: [/.*/],
  define: {
    __BUILDCHAIN_EMBEDDED_KFD_AGENT_RUNTIME_WASM_BASE64__: JSON.stringify(
      kfdAgentRuntimeVerifierWasmBase64,
    ),
  },
  esbuildOptions(options) {
    options.legalComments = "none";
  },
});
