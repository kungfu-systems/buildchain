import { defineConfig } from "tsup";

export default defineConfig({
  target: "node24",
  platform: "node",
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
