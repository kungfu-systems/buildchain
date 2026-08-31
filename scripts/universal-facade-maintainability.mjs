import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function loadUniversalFacadeMigration(root) {
  const contract = JSON.parse(
    fs.readFileSync(
      path.join(root, "architecture/v4-universal-workflow-bootstrap.json"),
      "utf8",
    ),
  );
  const retired = new Set(contract.retiredWorkflowSurfaces || []);
  const paths = (contract.bootstrapGovernedWorkflows || []).filter(
    (entry) =>
      entry !== contract.bootstrap?.publicWorkflow && !retired.has(entry),
  );
  const sourceRevision = contract.migration?.facadeSourceRevision || "";
  if (!/^[0-9a-f]{40}$/u.test(sourceRevision)) {
    throw new Error(
      "universal facade migration requires an exact facadeSourceRevision",
    );
  }
  return { paths: new Set(paths), sourceRevision };
}

function verifyUniversalFacadeMigration(root) {
  execFileSync(
    process.execPath,
    ["scripts/generate-v4-universal-workflow-facades.mjs", "--check"],
    { cwd: root, stdio: "pipe" },
  );
}

function governUniversalFacadeWorkflowMetrics({
  root,
  current,
  workflowMetricsAtRevision,
}) {
  const migration = loadUniversalFacadeMigration(root);
  verifyUniversalFacadeMigration(root);
  const frozen = workflowMetricsAtRevision(root, migration.sourceRevision);
  const governed = { ...current, workflows: { ...current.workflows } };
  for (const file of migration.paths) {
    if (!frozen[file])
      throw new Error(`frozen universal facade source is missing ${file}`);
    governed.workflows[file] = frozen[file];
  }
  return { governed, migration };
}

function isGeneratedFacadePublicTransition({
  entry,
  kind,
  migration,
  baseContract,
  currentContract,
}) {
  if (kind !== "workflow" || !migration?.paths.has(entry.path) || !baseContract)
    return false;
  const { inputs: currentInputs, ...currentRest } = currentContract;
  const { inputs: previousInputs, ...previousRest } = baseContract;
  if (JSON.stringify(currentRest) !== JSON.stringify(previousRest))
    return false;
  const added = currentInputs.filter(
    (input) => !previousInputs.includes(input),
  );
  const removed = previousInputs.filter(
    (input) => !currentInputs.includes(input),
  );
  return (
    removed.length === 0 &&
    added.length === 1 &&
    added[0] === "universal-request-json"
  );
}

export {
  governUniversalFacadeWorkflowMetrics,
  isGeneratedFacadePublicTransition,
  loadUniversalFacadeMigration,
  verifyUniversalFacadeMigration,
};
