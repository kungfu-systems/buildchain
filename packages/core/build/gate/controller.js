import path from "node:path";
import { execFileSync } from "node:child_process";
import { readJson } from "./files.js";
import { containedBuildPath } from "../build-configuration.js";
import { planControllerEvidence } from "../../observability/controller-evidence-io.js";
export function prepareGateProfileController({
  workspace,
  runtimeRoot,
  runtimeSha,
  runtimeRef,
  repository,
  request,
}) {
  const git = (directory) =>
    execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  if (git(runtimeRoot) !== runtimeSha)
    throw new Error("Gate runtime differs from admitted commit");
  const sourceRoot = path.join(workspace, "source");
  const sourceSha = git(sourceRoot);
  const cwd = containedBuildPath(
    sourceRoot,
    request["working-directory"] || ".",
  );
  const contract = readJson(
    path.join(runtimeRoot, "dist/site/buildchain-contract.json"),
  );
  const controller = planControllerEvidence({
    registryPath: path.join(runtimeRoot, "dist/site/controller-registry.json"),
    outputPath: path.join(workspace, ".buildchain/controller/plan.json"),
    controllerId: "shifu-gate-profile-envelope",
    source: { repository, sha: sourceSha },
    runtime: {
      ref: runtimeRef,
      sha: runtimeSha,
      contractDigest: contract.contractDigest,
    },
    inputs: request,
    inputBoundary: "workflow-call",
  });
  return { cwd, sourceSha, controller };
}
