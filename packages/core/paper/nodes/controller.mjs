import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
import {
  createPaperControllerPlan,
  createPaperControllerReceipt,
} from "../publication-controller.js";
import { runOperation } from "../../runtime/action-process.mjs";

const directory = ".buildchain/paper-controller";
const candidatePath = ".buildchain/admitted/controller/receipt.json";
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const gitSha = (cwd) =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
function writeDocument(kind, value, artifact) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    `${directory}/${kind}.json`,
    JSON.stringify(value, null, 2) + "\n",
  );
  writeGitHubOutputs({
    [`controller-${kind}-json`]: JSON.stringify(value),
    [`controller-${kind}-digest`]: value.digest,
    [`controller-${kind}-artifact`]: artifact,
    ...(kind === "receipt"
      ? {
          "controller-receipt-status": value.status,
          "controller-receipt-qualifying": String(value.qualifying),
        }
      : {}),
  });
}
function plan(env) {
  const candidateReceipt = readJson(candidatePath);
  const registry = readJson(
    fileURLToPath(
      new URL(
        "../../../../dist/site/controller-registry.json",
        import.meta.url,
      ),
    ),
  );
  const contract = readJson(
    fileURLToPath(
      new URL(
        "../../../../dist/site/buildchain-contract.json",
        import.meta.url,
      ),
    ),
  );
  const value = createPaperControllerPlan({
    descriptor: registry.controllers.find(
      (entry) => entry.id === "paper-release",
    ),
    candidateReceipt,
    source: { repository: env.GITHUB_REPOSITORY, sha: gitSha(".") },
    runtime: {
      ...candidateReceipt.runtime,
      sha: gitSha(".buildchain/runtime"),
      contractDigest: contract.contractDigest,
    },
    inputs: JSON.parse(env.REQUEST_JSON),
  });
  writeDocument("plan", value, `paper-controller-plan-${value.source.sha}`);
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
function receipt(env) {
  const plan = readJson(`${directory}/plan.json`);
  let candidateReceipt, passport;
  try {
    candidateReceipt = readJson(candidatePath);
  } catch {
    /* Failure is recorded by the controller. */
  }
  try {
    passport = readJson(env.RELEASE_PASSPORT_PATH);
  } catch {
    /* Missing Passport cannot qualify. */
  }
  const artifact = `paper-controller-receipt-${plan.source.sha}`;
  const value = createPaperControllerReceipt({
    plan,
    candidateReceipt,
    passport,
    artifact,
    publishOutcome: env.PUBLISH_OUTCOME,
    readbackOutcome: env.READBACK_OUTCOME,
    aggregateOutcome: env.AGGREGATE_OUTCOME,
    tag: env.RELEASE_TAG,
    evidence: [
      ...fileEvidence(env.MANIFEST_PATH, "publication-manifest"),
      ...fileEvidence(env.RELEASE_PASSPORT_PATH, "release-passport"),
    ],
  });
  writeDocument("receipt", value, artifact);
}
await runOperation({ plan, receipt });
