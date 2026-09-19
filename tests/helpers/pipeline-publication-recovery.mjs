import fs from "node:fs";
import { compileConsumerPlan } from "../../packages/core/consumer/contract/plan.js";
import { planPipelinePublication } from "../../packages/core/publication/pipeline/plan.js";
import { createDomainPublicationQualificationReceipt } from "../../packages/core/publication/publication-qualification.js";
import { pipelineProductCapsules } from "../../packages/core/publication/pipeline/capsules.js";
import { pipelineReleaseDocuments } from "../../packages/core/publication/pipeline/documents.js";
import { recordDigest } from "../../packages/core/release/discussion/envelope.js";

const rooted = (body) => ({ ...body, root: recordDigest(body) });

// Pure document fixtures. The signing observation here is injected test data,
// not a cryptographic verification or a live publication qualification.
export function publicationRecoveryFixture() {
  const now = new Date("2026-09-13T00:00:00Z"),
    issued = new Date(now.getTime() - 7200000);
  const contract = compileConsumerPlan(
    fs.readFileSync(
      "templates/minimal-consumer/paper/.buildchain/buildchain.toml",
      "utf8",
    ),
  );
  const source = {
    repository: "example/product",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
  };
  const runtime = {
    repository: "kungfu-systems/buildchain",
    commit: "c".repeat(40),
    tree: "d".repeat(40),
  };
  const publisher = {
    repository: runtime.repository,
    workflow: ".github/workflows/.release-pipeline-products.yml",
    workflowSha: "e".repeat(40),
    job: "apply",
  };
  const original = `attempt-${"1".repeat(64)}`;
  const plan = planPipelinePublication({
    attempt: original,
    generation: recordDigest("generation"),
    source,
    runtime,
    publisher,
    contract,
    route: contract.channels[1],
    version: "1.0.0-alpha.1",
    sourceTimestamp: issued.toISOString(),
  });
  const materialization = rooted({
    schema: "buildchain.pipeline-version-materialization/v1",
    planRoot: plan.root,
    protectedSource: source,
    source,
    material: { version: plan.version, changes: [] },
  });
  const artifacts = [
    {
      ...plan.outputs[0],
      file: "paper.pdf",
      size: 10,
      digest: recordDigest("fixture PDF"),
      manifestRoot: recordDigest("fixture manifest"),
      providerArtifactId: 1,
    },
  ];
  const qualification = createDomainPublicationQualificationReceipt({
    repository: source.repository,
    candidateRoot: recordDigest({ planRoot: plan.root, source, artifacts }),
    sourceSha: source.commit,
    sourceRoot: recordDigest(source),
    policyDigest: plan.contractRoot,
    artifacts: artifacts.map((item) => ({
      role: `${item.product}/${item.artifact}`,
      platform: item.platform,
      artifactRoot: item.digest,
      manifestRoot: item.manifestRoot,
    })),
    issuedAt: issued.toISOString(),
    expiresAt: new Date(issued.getTime() + 3600000).toISOString(),
  });
  const qualified = rooted({
    schema: "buildchain.pipeline-publication-qualification/v1",
    planRoot: plan.root,
    source,
    artifacts,
    qualification,
    build: {
      runId: 100,
      runAttempt: 1,
      providerSource: "f".repeat(40),
      root: recordDigest("fixture build"),
    },
  });
  const capsules = pipelineProductCapsules({
    plan,
    materialization,
    qualified,
    evaluatedAt: issued.toISOString(),
    bundles: [
      {
        providerArtifact: {
          id: 1,
          expires_at: new Date(now.getTime() + 86400000).toISOString(),
        },
      },
    ],
  });
  const signing = {
    verified: true,
    planRoot: plan.root,
    qualificationRoot: qualified.root,
    materializationRoot: materialization.root,
  };
  const documents = pipelineReleaseDocuments({
    plan,
    materialization,
    qualified,
    capsules,
    signing,
    evaluatedAt: issued.toISOString(),
  });
  const retained = {
    qualified,
    capsules,
    signing,
    documents,
    sealed: { root: recordDigest("fixture sealed bytes") },
  };
  const context = {
    attempt: `attempt-${"2".repeat(64)}`,
    generation: plan.generation,
    plan,
    materialization,
    runId: 200,
    runAttempt: 1,
    recovery: {
      predecessor: original,
      planRoot: recordDigest("recovery plan"),
    },
  };
  const execution = {
    attempt: context.attempt,
    runId: 200,
    runAttempt: 1,
    publisher: { ...publisher, workflowSha: "9".repeat(40) },
    runtime: { ...runtime, commit: "8".repeat(40), tree: "7".repeat(40) },
  };
  const effect = rooted({
    id: "exact-tag",
    kind: "exact-tag",
    tag: plan.tag,
    commit: source.commit,
  });
  return { now, context, execution, retained, effect };
}
