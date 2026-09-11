import { requireValue } from "../runtime/action-process.mjs";

export async function resolveArtifactCoordinate(
  { name, digest, sourceSha, runAttempt },
  { github, context },
) {
  requireValue(
    typeof name === "string" &&
      name.length > 0 &&
      name.length <= 256 &&
      !/[\0\r\n]/u.test(name),
    "Artifact name is invalid",
  );
  const expected = `sha256:${String(digest || "").replace(/^sha256:/u, "")}`;
  requireValue(
    /^sha256:[0-9a-f]{64}$/u.test(expected),
    "Artifact digest must be an exact sha256 coordinate",
  );
  requireValue(
    /^[0-9a-f]{40}$/u.test(sourceSha || ""),
    "Artifact source SHA must be exact",
  );
  requireValue(
    /^\d+$/u.test(String(context.runId)) && /^\d+$/u.test(String(runAttempt)),
    "Artifact requires exact workflow run coordinates",
  );
  const artifacts = await github.paginate(
    github.rest.actions.listWorkflowRunArtifacts,
    { ...context.repo, run_id: context.runId, per_page: 100 },
  );
  const matches = artifacts.filter(
    (artifact) => artifact.name === name && !artifact.expired,
  );
  requireValue(
    matches.length === 1,
    `Expected exactly one live artifact named ${name}, found ${matches.length}`,
  );
  const artifact = matches[0];
  requireValue(artifact.digest === expected, "Artifact digest mismatch");
  requireValue(
    /^\d+$/u.test(String(artifact.id)),
    "Artifact provider ID is invalid",
  );
  return {
    schema: "buildchain.github-artifact-coordinate/v1",
    repository: `${context.repo.owner}/${context.repo.repo}`,
    runId: String(context.runId),
    runAttempt: String(runAttempt),
    sourceSha,
    id: String(artifact.id),
    nodeId: artifact.node_id,
    name: artifact.name,
    digest: artifact.digest,
    sizeInBytes: artifact.size_in_bytes,
    createdAt: artifact.created_at,
    expiresAt: artifact.expires_at,
  };
}
