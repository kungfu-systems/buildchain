import fs from "node:fs";
import path from "node:path";
import artifact from "@actions/artifact";
import { recordDigest } from "../../release/discussion/envelope.js";
import { publicationPath } from "../../publication/pipeline/files.js";

export const pipelinePublicationArtifactName = (plan, platform) =>
  `buildchain-products-${plan.root.slice(7)}-${platform}`;

export function githubPipelinePublicationArtifacts({
  request,
  runs,
  repository,
  token,
  client = artifact,
}) {
  const prefix = `/repos/${repository}/actions`;
  async function upload(plan, manifest, directory) {
    const paths = [
      publicationPath(directory, "manifest.json"),
      ...manifest.artifacts.map(({ file }) => publicationPath(directory, file)),
    ];
    const result = await client.uploadArtifact(
      pipelinePublicationArtifactName(plan, manifest.platform),
      paths,
      directory,
      { retentionDays: 30, compressionLevel: 0 },
    );
    if (!result.id || !result.digest)
      throw new Error(
        "Product upload omitted its immutable provider coordinates",
      );
    return result;
  }
  async function buildReadback(context) {
    const { plan, materialization, runId, runAttempt } = context;
    const { run, jobs } = await runs.read(runId, runAttempt);
    const platforms = [
      ...new Set(plan.outputs.map(({ platform }) => platform)),
    ].sort();
    const selected = platforms.map((platform) => {
      const name = `Build publication (${platform})`;
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
          "Publication needs every exact credentialless build job to succeed",
        );
      return matches[0];
    });
    const response = await request(
      `${prefix}/runs/${runId}/artifacts?per_page=100`,
    );
    if (
      !Array.isArray(response.artifacts) ||
      response.total_count !== response.artifacts.length ||
      response.total_count > 100
    )
      throw new Error("Publication artifact inventory is incomplete");
    const assets = platforms.map((platform) => {
      const matches = response.artifacts.filter(
        (asset) =>
          asset.name === pipelinePublicationArtifactName(plan, platform),
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
          "Publication requires one retained artifact per exact platform",
        );
      return matches[0];
    });
    const again = await runs.read(runId, runAttempt);
    for (const job of selected)
      if (
        !again.jobs.some((entry) => recordDigest(entry) === recordDigest(job))
      )
        throw new Error(
          "Publication build changed during independent readback",
        );
    if (again.run.head_sha !== run.head_sha)
      throw new Error("Publication provider source changed during readback");
    const body = {
      schema: "buildchain.pipeline-publication-build-readback/v1",
      outcome: "success",
      planRoot: plan.root,
      source: materialization.source,
      runId,
      runAttempt,
      providerSource: run.head_sha,
      platforms,
      jobs: selected,
      artifactIds: assets.map(({ id }) => id).sort((a, b) => a - b),
    };
    return { build: { ...body, root: recordDigest(body) }, assets };
  }
  async function download(context, workspace) {
    const { build, assets } = await buildReadback(context);
    const [repositoryOwner, repositoryName] = repository.split("/");
    const bundles = [];
    for (const asset of assets) {
      const directory = path.join(workspace, String(asset.id));
      fs.mkdirSync(directory, { recursive: true });
      const result = await client.downloadArtifact(asset.id, {
        path: directory,
        expectedHash: asset.digest,
        findBy: {
          repositoryOwner,
          repositoryName,
          workflowRunId: context.runId,
          token,
        },
      });
      if (result.digestMismatch)
        throw new Error(
          "Product download digest does not match the provider archive",
        );
      const manifest = JSON.parse(
        fs.readFileSync(publicationPath(directory, "manifest.json"), "utf8"),
      );
      bundles.push({ directory, manifest, providerArtifact: asset });
    }
    return { build, bundles };
  }
  return { upload, download, buildReadback };
}
