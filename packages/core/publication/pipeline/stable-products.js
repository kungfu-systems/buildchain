import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordDigest } from "../../release/discussion/envelope.js";
import { readPipelineReleaseEvidence } from "../../providers/github/pipeline-release-evidence.js";
import { readPipelineCaller } from "../../providers/github/pipeline-run-entry.js";
import { verifyPipelinePublicationPlan } from "./plan.js";
import {
  verifyRootedPublication,
  pipelineReleaseDocuments,
} from "./documents.js";
import { verifyPipelineSigning } from "./signing.js";
import { reobservePublicationBuild } from "./recovery-build-readback.js";
import { writeImmutablePublicationFile } from "./files.js";
import { reobservePipelineNativeQualification } from "./native-recovery.js";

function assertPublishedPlan(stablePlan, source, values) {
  const { plan, qualification: qualified, release } = values;
  verifyPipelinePublicationPlan(plan);
  if (
    plan.evidenceVersion !== (plan.nativeSigning?.length ? 2 : 1) ||
    plan.channel !== "alpha" ||
    plan.version !== stablePlan.candidateVersion ||
    plan.tag !== source.candidate.tag ||
    plan.contractRoot !== stablePlan.contractRoot ||
    plan.route.operation !== "alpha" ||
    plan.route.to !== stablePlan.route.from ||
    plan.route.from !== stablePlan.developmentBranch ||
    (plan.outputDeclarationRoot || recordDigest(plan.outputs)) !==
      (stablePlan.outputDeclarationRoot || recordDigest(stablePlan.outputs)) ||
    recordDigest(qualified.source) !== recordDigest(source.source) ||
    recordDigest(release.source) !== recordDigest(source.source)
  )
    throw new Error(
      "Published product evidence differs from the exact Alpha contract or source",
    );
  if (
    plan.publisher.repository !== "kungfu-systems/buildchain" ||
    plan.publisher.workflow !==
      ".github/workflows/.release-pipeline-products.yml" ||
    plan.publisher.job !== "apply" ||
    !/^[0-9a-f]{40}$/u.test(plan.publisher.workflowSha || "") ||
    plan.runtime.repository !== "kungfu-systems/buildchain"
  )
    throw new Error(
      "Published product evidence requires the central publisher",
    );
  const issued = Date.parse(qualified.qualification?.issuedAt);
  if (
    !Number.isFinite(issued) ||
    issued > Date.parse(source.candidate.publishedAt)
  )
    throw new Error(
      "Published product qualification cannot postdate its Alpha release",
    );
}

function buildLeaves(build) {
  const pending = [build],
    leaves = [];
  let visited = 0;
  while (pending.length) {
    if (++visited > 100)
      throw new Error("Published product build lineage exceeds its bound");
    const value = pending.pop();
    verifyRootedPublication(value, value.schema);
    if (value.schema === "buildchain.pipeline-publication-build-readback/v1")
      leaves.push(value);
    else if (
      value.schema === "buildchain.pipeline-publication-requalification/v1"
    )
      pending.push(value.predecessorBuild);
    else if (
      value.schema ===
        "buildchain.pipeline-publication-build-qualification/v1" &&
      Array.isArray(value.segments) &&
      value.segments.length &&
      value.segments.length <= 100
    )
      pending.push(...value.segments.map(({ build: segment }) => segment));
    else
      throw new Error(
        "Published product build lineage has an unsupported producer",
      );
  }
  return leaves;
}

function assertBuildInventory(plan, qualified) {
  const expected = [
    ...new Set(plan.outputs.map(({ platform }) => platform)),
  ].sort();
  const descriptors = qualified.artifacts
    .map(
      ({
        file,
        size,
        digest,
        package: pkg,
        manifestRoot,
        providerArtifactId,
        ...value
      }) => value,
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  if (recordDigest(descriptors) !== recordDigest(plan.outputs))
    throw new Error(
      "Published product evidence must cover every declared output exactly",
    );
  const leaves = buildLeaves(qualified.build),
    platforms = [],
    jobs = [];
  for (const build of leaves) {
    if (
      build.outcome !== "success" ||
      !Array.isArray(build.platforms) ||
      !Array.isArray(build.jobs) ||
      build.platforms.length !== build.jobs.length ||
      !build.platforms.length ||
      recordDigest(build.source) !== recordDigest(qualified.source)
    )
      throw new Error(
        "Published product evidence lacks complete successful platform builds",
      );
    for (const [index, platform] of build.platforms.entries()) {
      const job = build.jobs[index],
        name = `Build publication (${platform})`;
      if (
        job.status !== "completed" ||
        job.conclusion !== "success" ||
        job.run_id !== build.runId ||
        job.run_attempt !== build.runAttempt ||
        !(job.name === name || job.name.endsWith(` / ${name}`))
      )
        throw new Error(
          "Published product build job does not match its platform or attempt",
        );
      jobs.push(job);
    }
    platforms.push(...build.platforms);
  }
  if (
    recordDigest(platforms.sort()) !== recordDigest(expected) ||
    new Set(jobs.map(({ id }) => id)).size !== jobs.length
  )
    throw new Error(
      "Published product jobs omit or repeat a declared platform",
    );
  return jobs;
}

async function signingRun(plan, qualified, host) {
  const { run, jobs } = await host.runs.read(
    qualified.build.runId,
    qualified.build.runAttempt,
  );
  if (run.head_sha !== qualified.build.providerSource)
    throw new Error("Published product signing run changed its source");
  await readPipelineCaller(
    run,
    qualified.source.configPath,
    host.request,
    host.repository,
  );
  const definitions = (run.referenced_workflows || []).filter((value) =>
    value.path?.startsWith(
      `${plan.publisher.repository}/${plan.publisher.workflow}@`,
    ),
  );
  const selected = jobs.filter(
    (job) =>
      job.name === "Qualify and sign products" ||
      job.name.endsWith(" / Qualify and sign products"),
  );
  if (
    definitions.length !== 1 ||
    definitions[0].sha !== plan.publisher.workflowSha ||
    selected.length !== 1 ||
    selected[0].run_id !== qualified.build.runId ||
    selected[0].run_attempt !== qualified.build.runAttempt ||
    selected[0].status !== "completed" ||
    selected[0].conclusion !== "success"
  )
    throw new Error(
      "Published product signature lacks its exact successful provider job",
    );
  return selected[0];
}

function completionTime(jobs, qualified, candidate) {
  const values = jobs.map((job) => Date.parse(job.completed_at));
  const issued = Date.parse(qualified.qualification.issuedAt);
  if (
    values.some((value) => !Number.isFinite(value)) ||
    values.slice(0, -1).some((value) => value > issued) ||
    values.at(-1) < issued ||
    Math.max(...values) > Date.parse(candidate.publishedAt)
  )
    throw new Error(
      "Published product job timing disagrees with qualification or release",
    );
  return new Date(Math.max(...values)).toISOString();
}

function verifyPublishedDocuments(values, bundle, directory, host, execute) {
  const {
    plan,
    qualification: qualified,
    capsules,
    release,
    invocation,
  } = values;
  const materialization = release.versionMaterialization;
  const signing = verifyPipelineSigning({
    plan,
    materialization,
    qualified,
    bundlePath: writeImmutablePublicationFile(
      path.join(directory, "attestation.json"),
      bundle,
    ),
    directory: path.join(directory, "signature"),
    token: host.token,
    // Historical evidence is checked at issue time. It never supplies fresh
    // Stable publisher admission or extends the original receipt's lifetime.
    evaluatedAt: qualified.qualification.issuedAt,
    ...(execute ? { execute } : {}),
  });
  const expected = pipelineReleaseDocuments({
    plan,
    materialization,
    qualified,
    capsules,
    signing,
    evaluatedAt: qualified.qualification.issuedAt,
  });
  if (
    recordDigest(expected.passport) !== recordDigest(release) ||
    recordDigest(expected.invocation.invocation) !== recordDigest(invocation)
  )
    throw new Error(
      "Published Passport or invocation differs from verified product evidence",
    );
  return signing;
}

export async function readPipelineStableProducts(
  stablePlan,
  source,
  host,
  { execute } = {},
) {
  verifyPipelinePublicationPlan(stablePlan);
  verifyRootedPublication(source, "buildchain.pipeline-stable-source/v1");
  if (
    host.repository !== stablePlan.source.repository ||
    source.planRoot !== stablePlan.root ||
    source.contractRoot !== stablePlan.contractRoot ||
    source.source.repository !== host.repository ||
    recordDigest(source.source) !== recordDigest(stablePlan.intentSource) ||
    source.candidate.sha !== source.source.commit ||
    source.candidate.tree !== source.source.tree ||
    source.candidate.tag !== `v${stablePlan.candidateVersion}` ||
    !Number.isFinite(Date.parse(source.candidate.publishedAt)) ||
    stablePlan.channel !== "stable"
  )
    throw new Error(
      "Stable product collection changed its admitted source or repository",
    );
  const evidence = await readPipelineReleaseEvidence(host, source.candidate);
  if (evidence.status === "missing") return evidence;
  assertPublishedPlan(stablePlan, source, evidence.values);
  const { plan, qualification: qualified } = evidence.values;
  const jobs = assertBuildInventory(plan, qualified);
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "buildchain-stable-products-"),
  );
  try {
    const signing = verifyPublishedDocuments(
      evidence.values,
      evidence.bundle,
      directory,
      host,
      execute,
    );
    await reobservePublicationBuild(qualified.build, qualified.source, host);
    const nativeJobs = await reobservePipelineNativeQualification(
      qualified,
      plan,
      host,
      host.signingHost,
    );
    const signer = await signingRun(plan, qualified, host);
    const completedAt = completionTime(
      [...jobs, ...nativeJobs, signer],
      qualified,
      source.candidate,
    );
    const body = {
      schema: "buildchain.pipeline-stable-products/v1",
      planRoot: stablePlan.root,
      sourceRoot: source.root,
      alphaPlanRoot: plan.root,
      qualificationRoot: qualified.root,
      signing,
      signer,
      buildRoot: qualified.build.root,
      assets: evidence.assets,
      canary: {
        id: "product-build",
        source: "release-candidate",
        status: "success",
        repository: host.repository,
        candidateSha: source.candidate.sha,
        completedAt,
        attestor: "github-actions[bot]",
        runtimeRef: plan.runtime.commit,
        evidenceUrl: `https://github.com/${host.repository}/actions/runs/${qualified.build.runId}/attempts/${qualified.build.runAttempt}`,
      },
    };
    return { ...body, root: recordDigest(body) };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
