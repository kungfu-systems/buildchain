import { defineConfig } from "tsup";

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
  esbuildOptions(options) {
    options.legalComments = "none";
  },
});
