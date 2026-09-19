import fs from "node:fs";
import path from "node:path";
import artifact from "@actions/artifact";
import { recordDigest } from "../../release/discussion/envelope.js";
import { githubPipelineRuns } from "./pipeline-runs.js";

const authorityRepository = "kungfu-systems/buildchain";
const workflowPath = ".github/workflows/public-release-signing-authority.yml";

function expectedJobs(operation) {
  if (
    operation.authority?.repository !== authorityRepository ||
    !/^[0-9a-f]{40}$/u.test(operation.authority.entrySha || "") ||
    !/^[0-9a-f]{40}$/u.test(operation.runtimeSha || "") ||
    !/^sha256:[0-9a-f]{64}$/u.test(operation.requestRoot || "") ||
    !/^[\w.-]+\/[\w.-]+$/u.test(operation.source?.repository || "") ||
    !Number.isSafeInteger(operation.source.runId) ||
    operation.source.runId < 1 ||
    !/^[A-Za-z0-9._-]{1,200}$/u.test(operation.correlationId || "") ||
    !/^[A-Za-z0-9._-]{1,200}$/u.test(operation.resultArtifact || "") ||
    !Array.isArray(operation.requestIds) ||
    !operation.requestIds.length ||
    operation.requestIds.length > 32 ||
    new Set(operation.requestIds).size !== operation.requestIds.length ||
    operation.requestIds.some((id) => !/^[A-Za-z0-9._-]+$/u.test(id))
  )
    throw new Error(
      "Native result readback requires one exact signing operation",
    );
  return [
    "Admit immutable signing requests",
    ...operation.requestIds.map((id) => `Developer ID ${id}`),
    "Publish immutable signed result set",
  ];
}

function admittedExecution(observed, operation, runId, runAttempt, names) {
  const { run, jobs } = observed;
  if (
    run.id !== runId ||
    run.run_attempt !== runAttempt ||
    run.repository?.full_name !== authorityRepository ||
    run.path !== workflowPath ||
    run.event !== "workflow_dispatch" ||
    run.head_sha !== operation.authority.entrySha ||
    run.display_title !==
      `Sign ${operation.source.repository} run ${operation.source.runId} (${operation.correlationId})` ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  )
    throw new Error(
      "Native authority execution differs from the admitted dispatch",
    );
  const selected = names.map((name) => {
    const matches = jobs.filter((job) => job.name === name);
    if (
      matches.length !== 1 ||
      !Number.isSafeInteger(matches[0].id) ||
      matches[0].id < 1 ||
      matches[0].run_id !== runId ||
      matches[0].run_attempt !== runAttempt ||
      matches[0].head_sha !== operation.authority.entrySha ||
      matches[0].status !== "completed" ||
      matches[0].conclusion !== "success"
    )
      throw new Error(
        "Native authority requires every exact successful signing job",
      );
    return matches[0];
  });
  if (new Set(selected.map((job) => job.id)).size !== selected.length)
    throw new Error("Native authority job identities are duplicated");
  return { run, jobs: selected };
}

export function githubPipelineNativeResults({
  request,
  token,
  client = artifact,
}) {
  const runs = githubPipelineRuns(request, authorityRepository);
  async function readback(operation, runId, runAttempt) {
    const names = expectedJobs(operation);
    const first = admittedExecution(
      await runs.read(runId, runAttempt),
      operation,
      runId,
      runAttempt,
      names,
    );
    const inventory = await request(
      `/repos/${authorityRepository}/actions/runs/${runId}/artifacts?per_page=100`,
    );
    if (
      !Array.isArray(inventory.artifacts) ||
      inventory.total_count !== inventory.artifacts.length ||
      inventory.total_count > 100
    )
      throw new Error("Native authority artifact inventory is incomplete");
    const matches = inventory.artifacts.filter(
      (item) => item.name === operation.resultArtifact,
    );
    const asset = matches[0];
    if (
      matches.length !== 1 ||
      !Number.isSafeInteger(asset.id) ||
      asset.id < 1 ||
      asset.expired ||
      asset.workflow_run?.id !== runId ||
      asset.workflow_run?.head_sha !== operation.authority.entrySha ||
      !/^sha256:[0-9a-f]{64}$/u.test(asset.digest || "")
    )
      throw new Error(
        "Native authority requires one exact immutable result artifact",
      );
    const again = admittedExecution(
      await runs.read(runId, runAttempt),
      operation,
      runId,
      runAttempt,
      names,
    );
    if (recordDigest(first) !== recordDigest(again))
      throw new Error("Native authority changed during independent readback");
    const body = {
      schema: "buildchain.pipeline-native-authority-readback/v1",
      operationRoot: recordDigest(operation),
      repository: authorityRepository,
      runId,
      runAttempt,
      entrySha: operation.authority.entrySha,
      runtimeSha: operation.runtimeSha,
      requestRoot: operation.requestRoot,
      jobs: first.jobs,
      artifact: asset,
    };
    return { ...body, root: recordDigest(body) };
  }
  async function download(operation, runId, runAttempt, directory) {
    const proof = await readback(operation, runId, runAttempt);
    // Every download gets a new owned directory: retained or attacker-supplied
    // files must never be merged into independently verified provider bytes.
    fs.mkdirSync(directory, { recursive: true });
    const output = fs.mkdtempSync(path.join(directory, "native-result-"));
    const result = await client.downloadArtifact(proof.artifact.id, {
      path: output,
      expectedHash: proof.artifact.digest,
      findBy: {
        repositoryOwner: "kungfu-systems",
        repositoryName: "buildchain",
        workflowRunId: runId,
        token,
      },
    });
    if (result.digestMismatch)
      throw new Error(
        "Native result download differs from the provider archive",
      );
    const again = await readback(operation, runId, runAttempt);
    if (again.root !== proof.root)
      throw new Error("Native authority changed while downloading its result");
    return { directory: output, proof };
  }
  async function reobserve(operation, proof) {
    const { root, ...body } = proof;
    if (
      proof.schema !== "buildchain.pipeline-native-authority-readback/v1" ||
      root !== recordDigest(body) ||
      proof.operationRoot !== recordDigest(operation)
    )
      throw new Error("Native retained authority proof changed its operation");
    const observed = admittedExecution(
      await runs.read(proof.runId, proof.runAttempt),
      operation,
      proof.runId,
      proof.runAttempt,
      expectedJobs(operation),
    );
    if (recordDigest(observed.jobs) !== recordDigest(proof.jobs))
      throw new Error(
        "Native retained authority jobs changed after qualification",
      );
    return proof;
  }
  return { readback, download, reobserve };
}
