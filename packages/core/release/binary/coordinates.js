import { requireValue } from "../../runtime/action-process.mjs";
export function validateBinaryPublicationSelection({
  runId,
  tag,
}) {
  requireValue(
    /^[1-9][0-9]*$/u.test(runId),
    "Binary release publication requires an exact evidence run id",
  );
  const match = /^v([0-9]+)\.([0-9]+)\.[0-9]+(-alpha\.[0-9]+)?$/u.exec(tag);
  requireValue(
    match,
    "Binary release publication requires an exact semver tag",
  );
  return {
    runId,
    tag,
      targetRef: `${match[3] ? "alpha" : "release"}/v${match[1]}/v${match[1]}.${match[2]}`,
  };
}

export async function resolveBinaryPublicationCoordinates({
  repository,
  runId,
  tag,
  github,
}) {
  const selected = validateBinaryPublicationSelection({
    runId,
    tag,
    });
  const [owner, repo] = repository.split("/");
  const first = await github.rest.repos.getCommit({
    owner,
    repo,
    ref: selected.tag,
  });
  const second = await github.rest.repos.getCommit({
    owner,
    repo,
    ref: selected.tag,
  });
  requireValue(
    /^[0-9a-f]{40}$/.test(first.data.sha),
    "Release tag did not resolve to an exact commit",
  );
  requireValue(
    first.data.sha === second.data.sha,
    "Release tag moved while resolving publication coordinates",
  );
  await github.rest.repos.getReleaseByTag({ owner, repo, tag: selected.tag });
  return {
    "evidence-run-id": selected.runId,
    "release-tag": selected.tag,
    "source-sha": first.data.sha,
    "target-ref": selected.targetRef,
    "publication-version": selected.tag.slice(1),
  };
}
