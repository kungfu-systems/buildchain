#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { v4ContentRoot } from "../packages/core/v4-canonical-contracts.js";
import { verifyV4TailResealPlatform } from "./v4-tail-reseal.mjs";

function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : String(args[index + 1] || "");
}

function fileRoot(file) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex")}`;
}

function writeCandidate(root, request, content) {
  const platform = request.platforms.find(({ id }) => id === "macos-arm64");
  const payload = path.join(root, "product/release/macos-arm64/payload.bin");
  fs.mkdirSync(path.dirname(payload), { recursive: true });
  fs.writeFileSync(payload, content);
  const relative = path.relative(root, payload);
  const file = {
    path: relative,
    size: fs.statSync(payload).size,
    digest: fileRoot(payload),
  };
  const manifest = {
    contract: "kungfu-buildchain-artifact",
    artifactName: platform.artifactName,
    git: {
      repository: request.repository,
      sha: request.source.sha,
      treeSha: request.source.treeSha,
      runId: String(request.source.runId),
      runAttempt: String(request.source.runAttempt),
    },
    platform: { id: platform.id, name: platform.name },
    files: [
      {
        path: relative,
        size: file.size,
        sha256: file.digest.replace(/^sha256:/u, ""),
      },
    ],
    summary: { fileCount: 1, totalBytes: file.size },
  };
  const manifestPath = path.join(root, "evidence/macos-arm64/manifest.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    artifactRoot: v4ContentRoot("tail-reseal-artifact-files", [file]),
    manifestRoot: fileRoot(manifestPath),
  };
}

export function rehearseV4TailResealMacos({
  fixturePath = "contracts/fixtures/v4-tail-reseal-v1/valid.json",
  outputPath = "",
} = {}) {
  const request = JSON.parse(
    fs.readFileSync(path.resolve(fixturePath), "utf8"),
  );
  const workRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-v4-tail-macos-"),
  );
  try {
    const retainedRoots = writeCandidate(workRoot, request, "unsigned");
    const platform = request.platforms.find(({ id }) => id === "macos-arm64");
    Object.assign(platform, retainedRoots);
    const retained = verifyV4TailResealPlatform({
      request,
      platformId: "macos-arm64",
      artifactRoot: workRoot,
      mode: "retained",
    });
    writeCandidate(workRoot, request, "signed-and-notarized");
    const resealed = verifyV4TailResealPlatform({
      request,
      platformId: "macos-arm64",
      artifactRoot: workRoot,
      mode: "resealed",
      providerReadbackRoot: request.signing.providerReadbackRoot,
    });
    const payload = {
      schema: "kungfu-buildchain-v4-tail-reseal-macos-rehearsal/v1",
      platformId: "macos-arm64",
      retained,
      resealed,
      buildStagesExecuted: 0,
      signingFinalizationExecutions: 1,
      providerReadbackRoot: request.signing.providerReadbackRoot,
    };
    const evidence = {
      ...payload,
      evidenceRoot: v4ContentRoot("tail-reseal-admission", payload),
    };
    if (outputPath) {
      const output = path.resolve(outputPath);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    return evidence;
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const evidence = rehearseV4TailResealMacos({
      fixturePath: flag(
        process.argv.slice(2),
        "fixture",
        "contracts/fixtures/v4-tail-reseal-v1/valid.json",
      ),
      outputPath: flag(process.argv.slice(2), "output"),
    });
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    console.error(`v4-tail-reseal-macos-rehearsal: ${error.message}`);
    process.exitCode = 1;
  }
}
