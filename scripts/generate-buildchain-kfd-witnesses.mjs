#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  createBuildchainKfd1Witness,
  createBuildchainKfd2Claims,
  createBuildchainKfd3ArtifactWitness,
  createBuildchainKfd3PrebuildWitness,
} from "../packages/core/buildchain-kfd-claims.js";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    cwd: process.cwd(),
    outputDir: ".buildchain/kfd",
    sourceSha: process.env.BUILDCHAIN_SOURCE_SHA || "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd") {
      args.cwd = argv[++index] || args.cwd;
    } else if (arg === "--output-dir") {
      args.outputDir = argv[++index] || args.outputDir;
    } else if (arg === "--source-sha") {
      args.sourceSha = argv[++index] || args.sourceSha;
    } else if (arg === "--help") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function gitSha(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function toRepoRelative(cwd, filePath) {
  return path.relative(cwd, filePath).replace(/\\/g, "/");
}

export function generateBuildchainKfdWitnesses({
  cwd = process.cwd(),
  outputDir = ".buildchain/kfd",
  sourceSha = "",
  emitOutputs = true,
} = {}) {
  const root = path.resolve(cwd);
  const outDir = path.resolve(root, outputDir);
  const resolvedSourceSha = sourceSha || gitSha(root);
  const paths = {
    kfd1Witness: path.join(outDir, "buildchain-kfd-1-witness.json"),
    kfd3PrebuildWitness: path.join(outDir, "buildchain-kfd-3-prebuild-witness.json"),
    kfd3ArtifactWitness: path.join(outDir, "buildchain-kfd-3-artifact-witness.json"),
    kfd2ClaimsDir: path.join(outDir, "kfd-2-claims"),
  };
  writeJson(paths.kfd1Witness, createBuildchainKfd1Witness({ root, sourceSha: resolvedSourceSha }));
  writeJson(paths.kfd3PrebuildWitness, createBuildchainKfd3PrebuildWitness({ root, sourceSha: resolvedSourceSha }));
  writeJson(paths.kfd3ArtifactWitness, createBuildchainKfd3ArtifactWitness({ root, sourceSha: resolvedSourceSha }));
  const witnessFiles = {
    "kfd-1-witness": toRepoRelative(root, paths.kfd1Witness),
    "kfd-3-prebuild-witness": toRepoRelative(root, paths.kfd3PrebuildWitness),
    "kfd-3-artifact-witness": toRepoRelative(root, paths.kfd3ArtifactWitness),
  };
  const kfd2ClaimPaths = createBuildchainKfd2Claims({ root, witnessFiles }).map((claim) => {
    const slug = String(claim.id || "claim")
      .replace(/^claim:/, "")
      .replace(/[^0-9A-Za-z._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "claim";
    const claimPath = path.join(paths.kfd2ClaimsDir, `${slug}.json`);
    writeJson(claimPath, claim);
    return claimPath;
  });
  const outputs = {
    "kfd-1-witness-jsons": toRepoRelative(root, paths.kfd1Witness),
    "kfd-2-claim-jsons": kfd2ClaimPaths.map((claimPath) => toRepoRelative(root, claimPath)).join(","),
    "kfd-3-prebuild-witness-jsons": toRepoRelative(root, paths.kfd3PrebuildWitness),
    "kfd-3-artifact-witness-jsons": toRepoRelative(root, paths.kfd3ArtifactWitness),
    "source-sha": resolvedSourceSha,
    "output-dir": toRepoRelative(root, outDir),
  };
  if (emitOutputs) {
    writeGitHubOutputs(outputs);
  }
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-self-kfd-witness-generation",
    outputs,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs();
    if (args.help) {
      process.stdout.write("Usage: generate-buildchain-kfd-witnesses [--cwd <repo>] [--output-dir <dir>] [--source-sha <sha>]\n");
      process.exit(0);
    }
    process.stdout.write(`${JSON.stringify(generateBuildchainKfdWitnesses(args), null, 2)}\n`);
  } catch (error) {
    console.error(`buildchain self KFD witnesses: ${error.message}`);
    process.exitCode = 1;
  }
}
