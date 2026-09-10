import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  createPaperControllerPlan,
  createPaperControllerReceipt,
} from "../publication-controller.js";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const gitSha = (cwd) =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
function writeDocument(workspace, kind, value, artifact) {
  const directory = path.join(workspace, ".buildchain/paper-controller");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    `${directory}/${kind}.json`,
    JSON.stringify(value, null, 2) + "\n",
  );
  return {
    [`controller-${kind}-json`]: JSON.stringify(value),
    [`controller-${kind}-digest`]: value.digest,
    [`controller-${kind}-artifact`]: artifact,
    ...(kind === "receipt"
      ? {
          "controller-receipt-status": value.status,
          "controller-receipt-qualifying": String(value.qualifying),
        }
      : {}),
  };
}
export function planPaperPublication({
  workspace,
  runtimeRoot,
  repository,
  request,
}) {
  const candidateReceipt = readJson(
    path.join(workspace, ".buildchain/admitted/controller/receipt.json"),
  );
  const registry = readJson(
    path.join(runtimeRoot, "dist/site/controller-registry.json"),
  );
  const contract = readJson(
    path.join(runtimeRoot, "dist/site/buildchain-contract.json"),
  );
  const value = createPaperControllerPlan({
    descriptor: registry.controllers.find(
      (entry) => entry.id === "paper-release",
    ),
    candidateReceipt,
    source: { repository: repository, sha: gitSha(workspace) },
    runtime: {
      ...candidateReceipt.runtime,
      sha: gitSha(runtimeRoot),
      contractDigest: contract.contractDigest,
    },
    inputs: request,
  });
  return writeDocument(
    workspace,
    "plan",
    value,
    `paper-controller-plan-${value.source.sha}`,
  );
}
function fileEvidence(file, kind) {
  if (!file || !fs.existsSync(file)) return [];
  return [
    {
      kind,
      digest: `sha256:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`,
    },
  ];
}
export function receiptPaperPublication({
  workspace,
  publishOutcome,
  readbackOutcome,
  aggregateOutcome,
  manifestPath,
  passportPath,
  releaseTag,
}) {
  const plan = readJson(
    path.join(workspace, ".buildchain/paper-controller/plan.json"),
  );
  let candidateReceipt, passport;
  try {
    candidateReceipt = readJson(
      path.join(workspace, ".buildchain/admitted/controller/receipt.json"),
    );
  } catch {
    /* Failure is recorded by the controller. */
  }
  try {
    passport = readJson(passportPath);
  } catch {
    /* Missing Passport cannot qualify. */
  }
  const artifact = `paper-controller-receipt-${plan.source.sha}`;
  const value = createPaperControllerReceipt({
    plan,
    candidateReceipt,
    passport,
    artifact,
    publishOutcome: publishOutcome,
    readbackOutcome: readbackOutcome,
    aggregateOutcome: aggregateOutcome,
    tag: releaseTag,
    evidence: [
      ...fileEvidence(manifestPath, "publication-manifest"),
      ...fileEvidence(passportPath, "release-passport"),
    ],
  });
  return writeDocument(workspace, "receipt", value, artifact);
}
