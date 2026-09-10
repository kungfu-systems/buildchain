import { defineConfig } from "tsup";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { actionBundleResources } from "../packages/core/contracts/action-inventory.js";

const resourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../packages/core/runtime",
);

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
  async onSuccess() {
    const dist = path.resolve("dist");
    const resources = fs
      .readdirSync(dist)
      .filter((file) => file.endsWith(".js"))
      .flatMap((file) => actionBundleResources(path.join(dist, file)));
    for (const destination of new Set(resources))
      fs.copyFileSync(
        path.join(resourceRoot, path.basename(destination)),
        destination,
      );
  },
  esbuildOptions(options) {
    options.legalComments = "none";
  },
});
