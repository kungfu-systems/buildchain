import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.js"],
  format: ["esm"],
  target: "node24",
  platform: "node",
  splitting: false,
  sourcemap: false,
  minify: true,
  clean: true,
  outDir: "dist",
  skipNodeModulesBundle: false,
  noExternal: [/.*/],
});
