import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { releaseTailRoot } from "../release-tail-provider-plane.js";
import {
  historicalEvidenceFiles,
  qualifyHistoricalEvidenceFiles,
} from "./historical-evidence-files.js";
import {
  historicalEvidenceFileKeys,
  historicalPromotionContext,
} from "./compatibility-context.js";
import { normalizeKfd3CollaborationInterfaceArtifactWitness } from "../../adoption/kfd-gate.js";
import { createInvariantPassportGate } from "../passport/invariants.js";

const filename = "buildchain.historical-evidence.json";
export const historicalEvidenceKeys = [
  "release-passport-kfd-3-artifact-verify-command",
  "release-passport-invariant-passport-command",
];
function evidenceCommands(value) {
  const inputs = historicalPromotionContext(value)?.inputs || {};
  return historicalEvidenceKeys
    .filter((key) => inputs[key])
    .map((key) => [key, inputs[key]]);
}
function needsEvidence(value) {
  return (
    evidenceCommands(value).length ||
    historicalEvidenceFileKeys.some(
      (key) => historicalPromotionContext(value)?.inputs[key],
    )
  );
}
export function historicalEvidencePaths(value, directory) {
  return needsEvidence(value) ? [path.join(directory, filename)] : [];
}
function materialRoot(directory) {
  if (
    !fs.lstatSync(directory).isDirectory() ||
    fs.lstatSync(directory).isSymbolicLink()
  )
    throw new Error(
      "Historical evidence materials require a regular directory",
    );
  const files = [];
  function visit(relative) {
    for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
      const file = path.join(relative, name);
      if (file === filename) continue;
      const stat = fs.lstatSync(path.join(directory, file));
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile())
        files.push({
          path: file.split(path.sep).join("/"),
          digest: crypto
            .createHash("sha256")
            .update(fs.readFileSync(path.join(directory, file)))
            .digest("hex"),
        });
      else
        throw new Error(
          "Historical evidence materials must contain only regular files",
        );
    }
  }
  visit("");
  return releaseTailRoot(files);
}
function runEvidenceCommand(key, command, sourceDirectory, environment) {
  const result = spawnSync(command, [], {
    cwd: sourceDirectory,
    shell: true,
    encoding: "utf8",
    env: environment,
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Historical ${key} failed with status ${result.status ?? "unavailable"}`,
    );
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Historical ${key} must emit valid JSON`);
  }
  if (key === historicalEvidenceKeys[0])
    return normalizeKfd3CollaborationInterfaceArtifactWitness(value);
  return createInvariantPassportGate([{ value }]);
}

export function qualifyHistoricalEvidence({
  context,
  sourceDirectory,
  candidateDirectory,
  sourceSha,
  environment = process.env,
}) {
  const commands = evidenceCommands(context);
  if (!needsEvidence(context)) return null;
  if (
    !/^[a-f0-9]{40}$/u.test(sourceSha) ||
    execFileSync("git", ["-C", sourceDirectory, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim() !== sourceSha
  )
    throw new Error(
      "Historical evidence requires the exact qualified candidate checkout",
    );
  const files = historicalEvidenceFiles(
    historicalPromotionContext(context).inputs,
    sourceDirectory,
  );
  const verifiedAt = execFileSync(
    "git",
    ["-C", sourceDirectory, "show", "-s", "--format=%cI", sourceSha],
    { encoding: "utf8" },
  ).trim();
  const before = materialRoot(candidateDirectory);
  const consumerBuildchain = path.join(sourceDirectory, ".buildchain");
  if (
    fs.existsSync(consumerBuildchain) &&
    fs.lstatSync(consumerBuildchain).isSymbolicLink()
  )
    throw new Error(
      "Historical product configuration cannot escape its source checkout",
    );
  fs.mkdirSync(consumerBuildchain, { recursive: true });
  // The old command path remains relative to its product source checkout.
  const link = path.join(consumerBuildchain, "release-candidate");
  if (fs.existsSync(link)) {
    if (
      !fs.lstatSync(link).isSymbolicLink() ||
      fs.realpathSync(link) !== fs.realpathSync(candidateDirectory)
    )
      throw new Error(
        "Historical candidate path is occupied by unrelated source content",
      );
  } else fs.symlinkSync(path.resolve(candidateDirectory), link, "dir");
  const home = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-historical-evidence-"),
  );
  const env = Object.fromEntries(
    ["PATH", "TMPDIR", "SYSTEMROOT", "SystemRoot", "PATHEXT"]
      .filter((key) => environment[key])
      .map((key) => [key, environment[key]]),
  );
  Object.assign(env, {
    HOME: home,
    BUILDCHAIN_RELEASE_CANDIDATE_PAYLOADS: path.join(
      candidateDirectory,
      "payloads",
    ),
  });
  let results;
  try {
    results = Object.fromEntries(
      commands.map(([key, command]) => [
        key,
        runEvidenceCommand(key, command, sourceDirectory, env),
      ]),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  if (materialRoot(candidateDirectory) !== before)
    throw new Error(
      "Historical evidence command changed qualified publication materials",
    );
  for (const passport of results[historicalEvidenceKeys[1]]?.passports || [])
    if (passport.source.revision !== sourceSha)
      throw new Error(
        "Historical invariant passport must bind the qualified source revision",
      );
  const gates = qualifyHistoricalEvidenceFiles({
    files,
    results,
    sourceDirectory,
    candidateDirectory,
    verifiedAt,
  });
  const body = {
    files,
    gates,
    schema: "buildchain.historical-evidence/v1",
    contextRoot: releaseTailRoot(historicalPromotionContext(context)),
    sourceSha,
    materialRoot: before,
    results,
  };
  const receipt = { ...body, receiptRoot: releaseTailRoot(body) };
  fs.writeFileSync(
    path.join(candidateDirectory, filename),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return receipt;
}

export function verifyHistoricalEvidence({
  context,
  candidateDirectory,
  sourceSha,
}) {
  if (!needsEvidence(context)) return null;
  const { receiptRoot, ...body } = JSON.parse(
    fs.readFileSync(path.join(candidateDirectory, filename), "utf8"),
  );
  if (
    body.schema !== "buildchain.historical-evidence/v1" ||
    receiptRoot !== releaseTailRoot(body) ||
    body.contextRoot !== releaseTailRoot(historicalPromotionContext(context)) ||
    body.sourceSha !== sourceSha ||
    body.materialRoot !== materialRoot(candidateDirectory)
  )
    throw new Error(
      "Historical evidence does not match the qualified candidate and invocation",
    );
  const keys = evidenceCommands(context)
    .map(([key]) => key)
    .sort();
  if (
    JSON.stringify(Object.keys(body.results || {}).sort()) !==
    JSON.stringify(keys)
  )
    throw new Error("Historical evidence is missing required command results");
  return { ...body, receiptRoot };
}
