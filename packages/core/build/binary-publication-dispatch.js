import { command, requireValue } from "../runtime/action-process.mjs";

export function dispatchBinaryPublication(
  { repository, tag, sha, runId },
  execute = command,
) {
  requireValue(
    /^[\w.-]+\/[\w.-]+$/u.test(repository || ""),
    "Binary publication requires an exact repository",
  );
  requireValue(
    /^[0-9a-f]{40}$/u.test(sha || ""),
    "Binary publication requires an exact runtime SHA",
  );
  requireValue(
    /^\d+$/u.test(runId || ""),
    "Binary publication requires an exact evidence run",
  );
  requireValue(
    /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag || ""),
    "Binary publication requires an exact release tag",
  );
  execute("gh", [
    "workflow",
    "run",
    "self-release-binary-assets.yml",
    "--repo",
    repository,
    "--ref",
    tag,
    "-f",
    `buildchain-ref=${sha}`,
    "-f",
    `evidence-run-id=${runId}`,
    "-f",
    `release-tag=${tag}`,
    "-f",
    "publication-used-nonces-json=[]",
  ]);
}

export function binaryPublicationDispatchAction(_core, env) {
  dispatchBinaryPublication({
    repository: env.GITHUB_REPOSITORY,
    tag: env.RELEASE_TAG,
    sha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
  });
}
