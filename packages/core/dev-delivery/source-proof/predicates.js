import { gitPatchRoot } from "../../providers/git/patch-root.js";
import path from "node:path";
import { devDeliveryContentRoot } from "../dev-delivery-warrant.js";
import { required, exactSha, jsonList, git, gitPathRoot } from "./io.js";
export function sourceQualificationPredicates(input = {}) {
  const cwd = path.resolve(input.cwd || process.cwd());
  const repository = required(input.repository, "repository");
  const protectedBase = required(input.protectedBase, "protectedBase");
  const qualifiedBase = exactSha(input.qualifiedBase, "qualifiedBase");
  const sourceHead = exactSha(input.sourceHead, "sourceHead");
  const sourceTree = exactSha(
    git(["rev-parse", `${sourceHead}^{tree}`], { cwd }),
    "sourceTree",
  );
  const policyPaths = jsonList(input.policyPaths, "policy paths");
  const closurePaths = jsonList(input.closurePaths, "closure paths");
  const dependencyPaths = jsonList(input.dependencyPaths, "dependency paths");
  const requiredContexts = jsonList(
    input.requiredContexts,
    "required contexts",
  );
  const affectedPaths = git(
    ["diff", "--name-only", "--no-renames", `${qualifiedBase}...${sourceHead}`],
    { cwd },
  )
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();
  const nodeVersion = required(input.nodeVersion, "nodeVersion");
  return {
    repository,
    protectedBase,
    qualifiedBase,
    sourceHead,
    sourceTree,
    sourceIdentityRoot: devDeliveryContentRoot({
      schema: "kungfu.buildchain.source-identity/v1",
      repository,
      protectedBase,
      qualifiedBase,
      sourceHead,
      sourceTree,
    }),
    sourcePatchRoot: gitPatchRoot({
      cwd,
      base: qualifiedBase,
      head: sourceHead,
      mergeBase: true,
    }),
    planRoot: devDeliveryContentRoot({
      schema: "kungfu.buildchain.source-qualification-plan/v1",
      mode: "source",
      workingDirectory: required(
        input.workingDirectory || ".",
        "workingDirectory",
      ),
      nodeVersion,
      policyPaths,
      closurePaths,
      dependencyPaths,
      requiredContexts,
    }),
    closureRoot: gitPathRoot(sourceHead, closurePaths, "source-closure", cwd),
    dependencyRoot: gitPathRoot(
      sourceHead,
      dependencyPaths,
      "source-dependencies",
      cwd,
    ),
    toolchainRoot: devDeliveryContentRoot({
      schema: "kungfu.buildchain.source-toolchain/v1",
      nodeVersion,
    }),
    policyRoot: gitPathRoot(sourceHead, policyPaths, "source-policy", cwd),
    requiredContextRoot: devDeliveryContentRoot({
      schema: "kungfu.buildchain.required-context-set/v1",
      contexts: requiredContexts,
    }),
    affectedPaths,
  };
}
