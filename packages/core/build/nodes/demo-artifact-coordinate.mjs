export async function resolveSourceArtifact({ github, context, core }) {
  const fs = await import("node:fs");
  const expectedName = process.env.EXPECTED_NAME || "";
  const expectedDigest = process.env.EXPECTED_DIGEST || "";
  if (
    !expectedName ||
    expectedName.length > 256 ||
    /[\0\r\n]/.test(expectedName)
  ) {
    throw new Error("source artifact name is invalid");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) {
    throw new Error(
      "source artifact digest must be an exact sha256 coordinate",
    );
  }
  const artifacts = await github.paginate(
    github.rest.actions.listWorkflowRunArtifacts,
    {
      owner: context.repo.owner,
      repo: context.repo.repo,
      run_id: context.runId,
      per_page: 100,
    },
  );
  const matches = artifacts.filter(
    (artifact) => artifact.name === expectedName && !artifact.expired,
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one live artifact named ${expectedName}, found ${matches.length}`,
    );
  }
  const artifact = matches[0];
  if (artifact.digest !== expectedDigest) {
    throw new Error(
      `artifact digest mismatch: expected ${expectedDigest}, observed ${artifact.digest || "<empty>"}`,
    );
  }
  fs.mkdirSync("gate-work", { recursive: true });
  fs.mkdirSync("gate-diagnostics", { recursive: true });
  fs.writeFileSync(
    "gate-work/source-artifact.json",
    JSON.stringify(
      {
        schema: "buildchain.github-artifact-coordinate/v1",
        repository: `${context.repo.owner}/${context.repo.repo}`,
        runId: String(context.runId),
        runAttempt: String(process.env.GITHUB_RUN_ATTEMPT || ""),
        sourceSha: process.env.SOURCE_SHA,
        id: String(artifact.id),
        nodeId: artifact.node_id,
        name: artifact.name,
        digest: artifact.digest,
        sizeInBytes: artifact.size_in_bytes,
        createdAt: artifact.created_at,
        expiresAt: artifact.expires_at,
      },
      null,
      2,
    ) + "\n",
  );
  core.setOutput("artifact-id", String(artifact.id));
}
