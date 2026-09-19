import assert from "node:assert/strict";
import { inspectWorkflowJob } from "./workflow-action-graph.mjs";

export function assertPipelinePublicationTopology(
  ledger,
  discoverReleaseTopology,
  root,
) {
  const pipeline = ledger.pipelinePublicationScope;
  assert.deepEqual(pipeline.workflowPaths, [
    ".github/workflows/.release-pipeline-products.yml",
    ".github/workflows/public-ops-pipeline.yml",
    ".github/workflows/public-ops-recover.yml",
    ".github/workflows/.ops-pipeline-execute.yml",
    ".github/workflows/.release-pipeline-version.yml",
    ".github/workflows/buildchain.yml",
    ".github/workflows/buildchain-recover.yml",
  ]);
  const pipelineTopology = discoverReleaseTopology(
    pipeline.workflowPaths,
    pipeline.workflowPaths,
  );
  assert.deepEqual(pipeline.observedTopology, pipelineTopology);
  for (const [name, ceiling] of Object.entries(pipeline.maximumMetrics))
    assert.ok(
      pipelineTopology.metrics[name] <= ceiling,
      `pipeline publication exceeds ${name}`,
    );
  for (const [job, module] of [
    ["qualify", "packages/core/publication/pipeline/qualify.js"],
    ["apply", "packages/core/publication/pipeline/apply.js"],
    ["settle", "packages/core/publication/pipeline/settle.js"],
  ])
    assert.ok(
      inspectWorkflowJob(pipeline.workflowPaths[0], job, root).modules.has(
        module,
      ),
    );
  const version = ".github/workflows/.release-pipeline-version.yml";
  assert.ok(
    inspectWorkflowJob(version, "build", root).modules.has(
      "packages/core/publication/pipeline/version-build.js",
    ),
  );
  assert.ok(
    inspectWorkflowJob(version, "materialize", root).modules.has(
      "packages/core/publication/pipeline/version-context.js",
    ),
  );
}
