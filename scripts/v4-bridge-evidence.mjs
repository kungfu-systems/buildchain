#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  bridgeBinary,
  buildV4Bridge,
  createV4HostRequest,
  runV4Bridge,
} from "./v4-bridge-bootstrap.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostScript = path.join(root, "scripts", "v4-host-adapter.mjs");

function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || fallback;
}

function git(rootPath, args) {
  return execFileSync("git", args, { cwd: rootPath, encoding: "utf8" }).trim();
}

function timed(run, iterations) {
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = process.hrtime.bigint();
    const result = run();
    const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;
    if (result.status !== 0) {
      throw new Error(
        result.stderr?.toString("utf8") || `probe exited ${result.status}`,
      );
    }
    samples.push(elapsed);
  }
  samples.sort((left, right) => left - right);
  return {
    iterations,
    medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(3)),
    minMs: Number(samples[0].toFixed(3)),
    maxMs: Number(samples.at(-1).toFixed(3)),
  };
}

function collectEvidence(args = process.argv.slice(2)) {
  const iterations = Number.parseInt(flag(args, "iterations", "7"), 10);
  if (!Number.isInteger(iterations) || iterations < 3 || iterations > 50) {
    throw new Error("--iterations must be between 3 and 50");
  }
  const build = buildV4Bridge({ release: true });
  if (build.status !== 0) throw new Error(build.stderr || build.stdout);
  const binary = bridgeBinary("release");
  const request = createV4HostRequest({
    command: "architecture.list",
    args: ["--json"],
  });
  const serialized = JSON.stringify(request);
  const direct = timed(
    () =>
      spawnSync(process.execPath, [hostScript], {
        cwd: root,
        input: serialized,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }),
    iterations,
  );
  const bridge = timed(
    () =>
      runV4Bridge(request, {
        mode: "exchange",
        profile: "release",
        encoding: "utf8",
      }),
    iterations,
  );

  const libnodeRoot = flag(
    args,
    "libnode-root",
    process.env.BUILDCHAIN_LIBNODE_ROOT || "",
  );
  let libnode = {
    observed: false,
    repository: "kungfu-systems/libnode",
    revision: null,
    artifactBytes: null,
  };
  if (libnodeRoot) {
    const artifact = fs
      .readdirSync(path.join(libnodeRoot, "dist", "node"))
      .find((entry) => /^libnode\..+\.(?:dylib|so|dll)$/u.test(entry));
    libnode = {
      observed: Boolean(artifact),
      repository: "kungfu-systems/libnode",
      revision: git(libnodeRoot, ["rev-parse", "HEAD"]),
      artifactBytes: artifact
        ? fs.statSync(path.join(libnodeRoot, "dist", "node", artifact)).size
        : null,
    };
  }

  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-v4-bridge-evidence",
    generatedAt: new Date().toISOString(),
    source: {
      buildchainRevision: git(root, ["rev-parse", "HEAD"]),
      rustc: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    selection: "rust-trunk-node-subprocess-host-v1",
    contractPath: "contracts/v4-host-contract-v1.schema.json",
    measurements: {
      directNodeHostColdStart: direct,
      rustSubprocessBridgeColdStart: bridge,
      rustReleaseBinaryBytes: fs.statSync(binary).size,
      libnode,
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    process.stdout.write(`${JSON.stringify(collectEvidence(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`buildchain v4 bridge evidence: ${error.message}\n`);
    process.exitCode = 1;
  }
}

export { collectEvidence, timed };
