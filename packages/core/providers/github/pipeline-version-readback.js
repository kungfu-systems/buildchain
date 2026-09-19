import { recordDigest } from "../../release/discussion/envelope.js";
import { readPipelineCaller } from "./pipeline-run-entry.js";

export const pipelineVersionArtifactName = (context, platform) =>
  `buildchain-version-${context.preparation.root.slice(7)}-${context.runId}-${context.runAttempt}-${platform}`;

export const pipelineVersionJobName = (preparation, platform) =>
  `Prepare version (${preparation.purpose}, ${platform})`;

export async function readPipelineVersionBuild(context, host) {
  const { preparation, runId, runAttempt, definitionSha } = context;
  const { repository, request, runs } = host;
  if (preparation.source.repository !== repository)
    throw new Error("Version preparation crossed its repository boundary");
  const { run, jobs } = await runs.read(runId, runAttempt);
  await readPipelineCaller(
    run,
    preparation.source.configPath,
    request,
    repository,
  );
  const definitions = (run.referenced_workflows || []).filter((entry) =>
    entry.path?.startsWith(
      "kungfu-systems/buildchain/.github/workflows/.release-pipeline-products.yml@",
    ),
  );
  const versionDefinitions = (run.referenced_workflows || []).filter((entry) =>
    entry.path?.startsWith(
      "kungfu-systems/buildchain/.github/workflows/.release-pipeline-version.yml@",
    ),
  );
  if (
    definitions.length !== 1 ||
    definitions[0].sha !== definitionSha ||
    versionDefinitions.length !== 1 ||
    versionDefinitions[0].sha !== definitionSha ||
    !/^[0-9a-f]{40}$/u.test(definitionSha || "")
  )
    throw new Error("Version preparation changed its exact hosted definition");
  const selected = preparation.platforms.map((platform) => {
    const name = pipelineVersionJobName(preparation, platform);
    const matches = jobs.filter(
      (job) => job.name === name || job.name.endsWith(` / ${name}`),
    );
    if (
      matches.length !== 1 ||
      matches[0].run_id !== runId ||
      matches[0].run_attempt !== runAttempt ||
      matches[0].status !== "completed" ||
      matches[0].conclusion !== "success"
    )
      throw new Error(
        "Version preparation requires every exact successful product job",
      );
    return matches[0];
  });
  if (
    !selected.length ||
    new Set(preparation.platforms).size !== selected.length
  )
    throw new Error(
      "Version preparation platform inventory is empty or duplicated",
    );
  const inventory = await request(
    `/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
  );
  if (
    !Array.isArray(inventory.artifacts) ||
    inventory.total_count !== inventory.artifacts.length ||
    inventory.total_count > 100
  )
    throw new Error("Version preparation artifact inventory is incomplete");
  const assets = preparation.platforms.map((platform) => {
    const matches = inventory.artifacts.filter(
      (asset) => asset.name === pipelineVersionArtifactName(context, platform),
    );
    if (
      matches.length !== 1 ||
      !Number.isSafeInteger(matches[0].id) ||
      matches[0].id < 1 ||
      matches[0].expired ||
      matches[0].workflow_run?.id !== runId ||
      matches[0].workflow_run?.head_sha !== run.head_sha ||
      !/^sha256:[0-9a-f]{64}$/u.test(matches[0].digest || "")
    )
      throw new Error(
        "Version preparation has no unique immutable platform artifact",
      );
    return matches[0];
  });
  const again = await runs.read(runId, runAttempt);
  if (
    again.run.head_sha !== run.head_sha ||
    recordDigest(again.run.referenced_workflows) !==
      recordDigest(run.referenced_workflows) ||
    selected.some(
      (job) =>
        !again.jobs.some((value) => recordDigest(value) === recordDigest(job)),
    )
  )
    throw new Error(
      "Version preparation producer changed during independent readback",
    );
  const body = {
    schema: "buildchain.pipeline-version-build-readback/v1",
    preparationRoot: preparation.root,
    source: preparation.source,
    runtime: preparation.runtime,
    runId,
    runAttempt,
    definitionSha,
    providerSource: run.head_sha,
    jobs: selected,
    artifacts: assets.map(({ id, digest }) => ({ id, digest })),
  };
  return { build: { ...body, root: recordDigest(body) }, assets };
}
