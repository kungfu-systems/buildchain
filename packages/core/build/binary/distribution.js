import fs from "node:fs";
import path from "node:path";
import {
  createBuildchainLogger,
  verifyBuildchainLogEvents,
} from "../../observability/logging.js";
import {
  planControllerEvidence,
  receiptControllerEvidence,
} from "../../observability/controller-evidence-io.js";
import { buildStandaloneBinary } from "../standalone/build.js";
import { writeChecksums } from "./checksums.js";
import { writeBinaryPublicationEvidence } from "../../publication/binary/evidence.js";
import { collectGitHubReleasePassport } from "../../release/passport/collection.js";
import { verifyReleasePassport } from "../../release/release-passport.js";
import { verifyArtifactPassport } from "../artifact-passport.js";
import { createReleaseEvidenceBundle } from "../release-evidence-bundle.js";

export function admitBinaryDistribution({ tag, ref, sourceSha }) {
  if (!/^v4\.\d+\.\d+(?:-alpha\.\d+)?$/.test(tag || ""))
    throw new Error("Binary distribution requires a current v4 release tag");
  if (ref !== `refs/tags/${tag}`)
    throw new Error("Dispatch Binary Distribution at the exact release tag");
  if (!/^[0-9a-f]{40}$/.test(sourceSha || ""))
    throw new Error("Binary distribution requires an exact source SHA");
}
function summarizeEvidence({
  logger,
  workspace,
  outputDir,
  suffix,
  minEvents,
  phases,
  components,
  events,
}) {
  const report = verifyBuildchainLogEvents({
    path: logger.path,
    minEvents,
    requirePhases: phases,
    requireComponents: components,
    requireEvents: events,
  });
  if (!report.ok)
    throw new Error(
      `Binary observability evidence did not qualify: ${JSON.stringify(report.issues)}`,
    );
  const directory = path.resolve(workspace, outputDir);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `buildchain-log-summary-${suffix}.json`),
    JSON.stringify(logger.summary(), null, 2) + "\n",
  );
  fs.copyFileSync(
    logger.path,
    path.join(directory, `buildchain-log-events-${suffix}.jsonl`),
  );
}
export async function buildBinaryDistribution(
  { workspace, tag, platform, runner, nodePath, nodeVersion, logPath },
  build = buildStandaloneBinary,
) {
  const logger = createBuildchainLogger({
    cwd: workspace,
    path: logPath,
    source: "buildchain",
    component: "workflow",
    phase: "binary",
    console: true,
  });
  logger.info("binary.matrix.start", {
    phase: "setup",
    attributes: { platform, runner },
  });
  const manifest = await logger.span(
    "binary.standalone-build",
    { attributes: { platform } },
    () =>
      build({
        cwd: workspace,
        version: tag,
        outputDir: "dist/binary",
        logPath,
        nodePath,
        nodeVersion,
      }),
  );
  logger.info("binary.matrix.complete", {
    phase: "evidence",
    attributes: { platform },
  });
  summarizeEvidence({
    logger,
    workspace,
    outputDir: "dist/binary",
    suffix: platform,
    minEvents: 8,
    phases: ["setup", "binary", "prepare", "package", "archive", "evidence"],
    components: ["workflow", "standalone-binary"],
    events: [
      "binary.matrix.start",
      "binary.matrix.complete",
      "standalone.build.complete",
    ],
  });
  return manifest;
}
export function binaryPassportOptions({
  workspace,
  tag,
  repository,
  sourceSha,
  workflow,
}) {
  const evidence = path.join(workspace, ".buildchain/publication-evidence"),
    release = JSON.parse(
      fs.readFileSync(path.join(evidence, "release.json"), "utf8"),
    );
  if (release.publishedVersion !== String(tag || "").replace(/^v/, ""))
    throw new Error(
      "Binary passport version must match the publication settlement",
    );
  return {
    cwd: workspace,
    tag,
    repository,
    sourceSha,
    assetsDir: path.join(workspace, "dist/binary"),
    outputDir: path.join(workspace, ".buildchain/release-passport"),
    releaseEvidenceJsons: [
      path.join(evidence, "buildchain-publication-settlement.json"),
    ],
    releaseJsonExtra: path.join(evidence, "release.json"),
    packageVersion: release.publishedVersion,
    workflow,
  };
}
export async function qualifyBinaryDistribution({
  workspace,
  tag,
  repository,
  sourceSha,
  workflow,
  logPath,
  client,
}) {
  const contract = JSON.parse(
    fs.readFileSync(
      path.join(workspace, "dist/site/buildchain-contract.json"),
      "utf8",
    ),
  );
  const planPath = path.join(workspace, ".buildchain/controller/plan.json"),
    receiptPath = path.join(workspace, ".buildchain/controller/receipt.json");
  planControllerEvidence({
    registryPath: path.join(workspace, "dist/site/controller-registry.json"),
    outputPath: planPath,
    controllerId: "binary-distribution",
    source: { repository, sha: sourceSha },
    runtime: {
      ref: sourceSha,
      sha: sourceSha,
      contractDigest: contract.contractDigest,
    },
    inputs: {},
    inputBoundary: "workflow-call",
  });
  const logger = createBuildchainLogger({
    cwd: workspace,
    path: logPath,
    source: "buildchain",
    component: "workflow",
    phase: "passport",
    console: true,
  });
  const binaryDir = path.join(workspace, "dist/binary"),
    passportDir = path.join(workspace, ".buildchain/release-passport"),
    passportLocation = path.join(passportDir, "buildchain.release.json");
  await logger.span("release-passport.checksums", {}, () =>
    writeChecksums(binaryDir),
  );
  await writeBinaryPublicationEvidence({
    workspace,
    client,
    repository,
    tag,
    sourceSha,
  });
  await logger.span("release-passport.collect", {}, () => {
    const result = collectGitHubReleasePassport(
      binaryPassportOptions({
        workspace,
        tag,
        repository,
        sourceSha,
        workflow,
      }),
    );
    if (!result.checkReport.ok)
      throw new Error("Collected binary passport did not qualify");
    return result;
  });
  await logger.span("release-passport.verify", {}, async () => {
    const report = await verifyReleasePassport({ passportLocation });
    if (!report.ok) throw new Error("Binary passport verification failed");
  });
  for (const entry of fs.readdirSync(binaryDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    await logger.span("release-passport.verify-artifact", {}, async () => {
      const report = await verifyArtifactPassport({
        subject: path.join(binaryDir, entry.name),
        cwd: workspace,
        passportLocation,
      });
      if (!report.ok)
        throw new Error(`Binary artifact did not qualify: ${entry.name}`);
    });
  }
  logger.info("release-passport.complete", { phase: "evidence" });
  summarizeEvidence({
    logger,
    workspace,
    outputDir: passportDir,
    suffix: "passport",
    minEvents: 7,
    phases: ["passport", "evidence"],
    components: ["workflow"],
    events: [
      "release-passport.checksums.start",
      "release-passport.checksums.end",
      "release-passport.collect.start",
      "release-passport.collect.end",
      "release-passport.verify.start",
      "release-passport.verify.end",
      "release-passport.complete",
    ],
  });
  const bundle = createReleaseEvidenceBundle({
    cwd: workspace,
    assetsDir: binaryDir,
    passportDir,
    outputDir: passportDir,
    tag,
    sourceSha,
  });
  const receipt = receiptControllerEvidence({
    planPath,
    outputPath: receiptPath,
    stages: ["resolve-runtime", "build", "verify", "bundle", "aggregate"].map(
      (id) => ({ id, status: "passed" }),
    ),
    evidenceFiles: [
      {
        kind: "release-evidence-bundle",
        path: bundle.manifestPath,
        artifact: "buildchain-release-passport",
      },
      {
        kind: "release-passport",
        path: passportLocation,
        artifact: "buildchain-release-passport",
      },
    ],
    artifact: "buildchain-controller-binary-distribution",
  });
  if (!receipt.qualifying)
    throw new Error(
      `Binary distribution receipt is not qualifying: ${receipt.status}`,
    );
  return { receipt, bundle };
}
