#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { spawnSyncCommand } from "../packages/core/spawn-command.js";
import { selectV4ProductPublicationIntent } from "../packages/core/v4-product-publication.js";
import { v4ContentRoot } from "../packages/core/v4-canonical-contracts.js";

function env(name, required = false) {
  const value = String(process.env[name] || "").trim();
  if (required && !value) throw new Error(`${name} is required`);
  return value;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function packageName(artifactKind) {
  if (artifactKind !== "npm") return "";
  const declared = env("BUILDCHAIN_PUBLISH_PACKAGE_MAIN");
  if (declared) return declared;
  const manifestPath = env("BUILDCHAIN_SEALED_BUNDLE_MANIFEST", true);
  const manifest = readJson(manifestPath);
  const selected = String(manifest?.npm?.name || "").trim();
  if (!selected)
    throw new Error("sealed bundle manifest does not declare npm.name");
  return selected;
}

function observedVersions(name) {
  const result = spawnSyncCommand(
    "npm",
    [
      "view",
      name,
      "versions",
      "--json",
      "--registry=https://registry.npmjs.org/",
    ],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (/\bE404\b|404 Not Found|is not in this registry/iu.test(output))
      return [];
    throw new Error(`npm version discovery failed: ${output.trim()}`);
  }
  const parsed = JSON.parse(String(result.stdout || "[]"));
  return Array.isArray(parsed) ? parsed : [parsed].filter(Boolean);
}

function writeOutput(name, value) {
  const output = env("GITHUB_OUTPUT");
  if (!output) return;
  fs.appendFileSync(output, `${name}=${String(value)}\n`);
}

export function resolveV4ProductPublicationIntent() {
  const artifactKind = env("BUILDCHAIN_PUBLISH_ARTIFACT_KIND") || "npm";
  const name = packageName(artifactKind);
  const sourceSha = env("BUILDCHAIN_SOURCE_SHA", true);
  const manifestPath = env(
    "BUILDCHAIN_SEALED_BUNDLE_MANIFEST",
    artifactKind === "npm",
  );
  const manifest = manifestPath ? readJson(manifestPath) : null;
  const requiredArtifacts = readJson(
    env("BUILDCHAIN_REQUIRED_ARTIFACTS_PATH", true),
  );
  const channel = env("BUILDCHAIN_CHANNEL", true);
  const intent = selectV4ProductPublicationIntent({
    channel,
    targetRef: env("BUILDCHAIN_TARGET_REF", true),
    sourceSha,
    sourceTimestamp: env("BUILDCHAIN_SOURCE_TIMESTAMP", true),
    repository: env("BUILDCHAIN_REPOSITORY", true),
    artifactKind,
    packageName: name,
    distTag:
      env("BUILDCHAIN_PUBLISH_DIST_TAG") ||
      (channel === "alpha" ? "alpha" : "latest"),
    sealedBundleRoot: manifest?.root,
    requiredArtifactsRoot: v4ContentRoot(
      "v4-product-required-artifacts",
      requiredArtifacts,
    ),
    candidateVersion: env("BUILDCHAIN_CANDIDATE_VERSION", true),
    recoveredVersion: env("BUILDCHAIN_RECOVERED_PUBLICATION_VERSION"),
    observedVersions: artifactKind === "npm" ? observedVersions(name) : [],
  });
  const outputPath = path.resolve(
    env("BUILDCHAIN_PRODUCT_PUBLICATION_INTENT_PATH") ||
      ".buildchain/release-candidate/v4-product-publication-intent.json",
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(intent, null, 2)}\n`);
  writeOutput("version", intent.version);
  writeOutput("exact-tag", intent.exactTag);
  writeOutput("intent-path", outputPath);
  writeOutput("intent-root", intent.intentRoot);
  return { name: name || artifactKind, intent, outputPath };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = resolveV4ProductPublicationIntent();
    process.stdout.write(
      `v4 product publication intent: ${result.name}@${result.intent.version} (${result.intent.mode})\n`,
    );
  } catch (error) {
    console.error(`v4-product-publication-intent: ${error.message}`);
    process.exitCode = 1;
  }
}
