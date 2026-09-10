import path from "node:path";
import fs from "node:fs";
import { jsonText, extractUrls, safeParseJson, toPosix } from "./files.js";
import {
  NPM_REGISTRY,
  DEFAULT_BOOTSTRAP_VERSION,
  PAPER_NPM_BOOTSTRAP_CONTRACT,
} from "./identity.js";
import { executePaperNpmBootstrap as executePaperNpmBootstrapOperation } from "../paper-npm-bootstrap.js";
import {
  PAPER_PATHS,
  commandResult,
  normalizeRepository,
  paperConfig,
  resolvePaperRepository,
} from "../paper-repository.js";
import os from "node:os";
import {
  expectedPaperTrustedPublisher,
  validatePaperProvisioningAuthority,
} from "./provisioning-validation.js";
import {
  liveNpmAuthObservation,
  liveNpmPackageObservation,
  liveNpmTrustObservation,
} from "./npm-observation.js";
import { normalizePackageName } from "./runtime.js";
export function writePaperReceipt(cwd, relativePath, value) {
  const target = path.resolve(cwd, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, jsonText(value));
  return relativePath;
}
export function bootstrapPackageShape({ packageName, version }) {
  return {
    name: packageName,
    version,
    private: false,
    license: "Apache-2.0",
    description: "Bootstrap package for npm Trusted Publishing setup.",
    publishConfig: {
      access: "public",
      registry: NPM_REGISTRY,
    },
  };
}
export function executePaperNpmBootstrap(options = {}) {
  return executePaperNpmBootstrapOperation(options, {
    DEFAULT_BOOTSTRAP_VERSION,
    NPM_REGISTRY,
    PAPER_NPM_BOOTSTRAP_CONTRACT,
    PAPER_PATHS,
    bootstrapPackageShape,
    commandResult,
    expectedPaperTrustedPublisher,
    extractUrls,
    fs,
    jsonText,
    liveNpmAuthObservation,
    liveNpmPackageObservation,
    liveNpmTrustObservation,
    normalizePackageName,
    normalizeRepository,
    os,
    paperConfig,
    path,
    resolvePaperRepository,
    safeParseJson,
    toPosix,
    validatePaperProvisioningAuthority,
    writePaperReceipt,
  });
}
