import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createBuildchainLogger } from "../../observability/logging.js";
import {
  timed,
  relativePath,
  writeLogSummary,
  readLogPath,
  noopLogger,
} from "./logging.js";
import { platformTriple, copyNodeBinary, sourceSha } from "./identity.js";
import { bundleCli, postjectArgs } from "./bundle.js";
import { run } from "./process.js";
function prepareStandaloneExecutable({
  cwd,
  tempDir,
  version,
  logger,
  nodePath,
  resolvedOutputDir,
  name,
}) {
  const blobPath = path.join(tempDir, "sea-prep.blob");
  const configPath = path.join(tempDir, "sea-config.json");
  const bundledCliPath = bundleCli({
    cwd,
    tempDir,
    version,
    logger,
  });
  timed(
    logger,
    "standalone.sea-config.write",
    {
      phase: "prepare",
      attributes: {
        configPath,
        blobPath,
        bundledCliPath,
      },
    },
    () => {
      fs.writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            main: bundledCliPath,
            mainFormat: "commonjs",
            output: blobPath,
            disableExperimentalSEAWarning: true,
            useSnapshot: false,
            useCodeCache: false,
          },
          null,
          2,
        )}\n`,
      );
    },
  );
  run(nodePath, ["--experimental-sea-config", configPath], {
    cwd,
    logger,
    event: "standalone.sea-blob.create",
    phase: "prepare",
  });
  const extension = process.platform === "win32" ? ".exe" : "";
  const binaryPath = path.join(resolvedOutputDir, `${name}${extension}`);
  timed(
    logger,
    "standalone.node.copy",
    {
      phase: "prepare",
      attributes: {
        source: nodePath,
        destination: relativePath(cwd, binaryPath),
      },
    },
    () => copyNodeBinary(binaryPath, nodePath),
  );
  if (process.platform === "darwin") {
    timed(
      logger,
      "standalone.codesign.remove",
      {
        phase: "sign",
        attributes: {
          binary: relativePath(cwd, binaryPath),
        },
      },
      () => {
        spawnSync("codesign", ["--remove-signature", binaryPath], {
          stdio: "ignore",
        });
      },
    );
  }
  run("npx", postjectArgs(binaryPath, blobPath), {
    cwd,
    logger,
    event: "standalone.sea-blob.inject",
    phase: "package",
  });
  if (process.platform === "darwin") {
    run("codesign", ["--sign", "-", binaryPath], {
      logger,
      event: "standalone.codesign.adhoc",
      phase: "sign",
    });
  }

  return binaryPath;
}

export function buildStandaloneBinary({
  cwd = process.cwd(),
  outputDir = "dist/binary",
  name = "buildchain",
  version = "",
  packageManagerInstall = false,
  logPath = undefined,
  nodePath = process.execPath,
  nodeVersion = process.version,
} = {}) {
  const resolvedOutputDir = path.resolve(cwd, outputDir);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-sea-"));
  try {
    const triple = platformTriple();
    const archiveBase = `${name}-${triple}`;
    const logger =
      createBuildchainLogger({
        cwd,
        path: readLogPath(logPath),
        source: "buildchain",
        component: "standalone-binary",
        phase: "binary",
        attributes: {
          name,
          version,
          platform: triple,
          outputDir: relativePath(cwd, resolvedOutputDir),
        },
      }) || noopLogger();
    logger.info("standalone.build.requested", {
      attributes: {
        packageManagerInstall,
        node: nodeVersion,
      },
    });
    fs.mkdirSync(resolvedOutputDir, { recursive: true });
    if (packageManagerInstall) {
      run("pnpm", ["install", "--frozen-lockfile"], {
        cwd,
        logger,
        event: "standalone.dependencies.install",
        phase: "setup",
      });
    }
    const binaryPath = prepareStandaloneExecutable({
      cwd,
      tempDir,
      version,
      logger,
      nodePath,
      resolvedOutputDir,
      name,
    });
    const archiveName =
      process.platform === "win32"
        ? `${archiveBase}.zip`
        : `${archiveBase}.tar.gz`;
    const archivePath = path.join(resolvedOutputDir, archiveName);
    if (process.platform === "win32") {
      run(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Compress-Archive -Path '${binaryPath.replaceAll("'", "''")}' -DestinationPath '${archivePath.replaceAll("'", "''")}' -Force`,
        ],
        {
          logger,
          event: "standalone.archive.create",
          phase: "archive",
        },
      );
    } else {
      run(
        "tar",
        [
          "-czf",
          archivePath,
          "-C",
          resolvedOutputDir,
          path.basename(binaryPath),
        ],
        {
          logger,
          event: "standalone.archive.create",
          phase: "archive",
        },
      );
    }
    const binarySha256 = crypto
      .createHash("sha256")
      .update(fs.readFileSync(binaryPath))
      .digest("hex");
    const manifest = {
      schemaVersion: 1,
      contract: "kungfu-buildchain-standalone-binary",
      name,
      version,
      platform: triple,
      platformId:
        process.platform === "linux" && process.arch === "x64"
          ? "linux-x64"
          : triple,
      binary: relativePath(cwd, binaryPath),
      sha256: binarySha256,
      executableFiles: [
        { path: path.basename(binaryPath), sha256: binarySha256 },
      ],
      sourceSha: sourceSha(cwd),
      runtimeDependencies: [],
      archive: relativePath(cwd, archivePath),
      node: nodeVersion,
      observability: {
        eventLog: logger.path ? relativePath(cwd, logger.path) : "",
        summary: logger.path
          ? relativePath(
              cwd,
              path.join(resolvedOutputDir, `${archiveBase}.log-summary.json`),
            )
          : "",
      },
    };
    timed(
      logger,
      "standalone.manifest.write",
      {
        phase: "evidence",
        attributes: {
          manifest: `${archiveBase}.json`,
        },
      },
      () => {
        fs.writeFileSync(
          path.join(resolvedOutputDir, `${archiveBase}.json`),
          `${JSON.stringify(manifest, null, 2)}\n`,
        );
      },
    );
    logger.info("standalone.build.complete", {
      attributes: {
        archive: manifest.archive,
        binary: manifest.binary,
      },
    });
    writeLogSummary(logger, cwd, resolvedOutputDir, archiveBase);
    return manifest;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
