import fs from "node:fs";
import path from "node:path";
import { run } from "./process.js";
import { packageVersion, sourceSha } from "./identity.js";
export function bundleCli({ cwd, tempDir, version, logger }) {
  const outDir = path.join(tempDir, "bundle");
  const configPath = path.join(tempDir, "tsup.config.mjs");
  const embeddedContractWorld = fs.readFileSync(
    path.join(cwd, "dist", "site", "buildchain-contract.json"),
    "utf8",
  );
  const embeddedLicenseText = fs.readFileSync(
    path.join(cwd, "LICENSE"),
    "utf8",
  );
  fs.writeFileSync(
    configPath,
    `export default {
  entry: {
    buildchain: ${JSON.stringify(path.join(cwd, "bin", "buildchain.mjs"))},
  },
  format: ["cjs"],
  platform: "node",
  target: "node24",
  outDir: ${JSON.stringify(outDir)},
  clean: true,
  silent: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  shims: true,
  noExternal: [/.*/], // SEA has no installed package resolver.
  define: {
    "process.env.BUILDCHAIN_EMBEDDED_PACKAGE_VERSION": ${JSON.stringify(JSON.stringify(version || packageVersion(cwd)))},
    "process.env.BUILDCHAIN_EMBEDDED_SOURCE_SHA": ${JSON.stringify(JSON.stringify(sourceSha(cwd)))},
    "process.env.BUILDCHAIN_EMBEDDED_CONTRACT_WORLD": ${JSON.stringify(JSON.stringify(embeddedContractWorld))},
    "process.env.BUILDCHAIN_EMBEDDED_LICENSE_TEXT": ${JSON.stringify(JSON.stringify(embeddedLicenseText))},
    "process.env.BUILDCHAIN_EMBEDDED_ENTRYPOINT": ${JSON.stringify(JSON.stringify("1"))},
  },
};
`,
  );
  run("pnpm", ["exec", "tsup", "--config", configPath], {
    cwd,
    logger,
    event: "standalone.cli-bundle.create",
    phase: "prepare",
    attributes: {
      outDir,
    },
  });
  return path.join(outDir, "buildchain.cjs");
}

export function postjectArgs(binaryPath, blobPath) {
  const args = [
    "--yes",
    "postject",
    binaryPath,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ];
  if (process.platform === "darwin") {
    args.push("--macho-segment-name", "NODE_SEA");
  }
  return args;
}
