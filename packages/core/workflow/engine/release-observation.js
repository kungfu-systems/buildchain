import { githubJson } from "../../release/candidate/transport.js";
import { productStateVersion } from "../universal-workflow-bootstrap.js";
import { planReleaseRoute } from "../../release/release-invocation.js";
import { fail } from "./identity.js";
export async function observeReleaseRoute(
  { repository, targetRef, requestedSha, inputs },
  { token, apiUrl },
) {
  const observed = await githubJson({
    apiUrl,
    token,
    path: `/repos/${repository}/git/ref/heads/${targetRef}`,
  });
  const currentSha = observed.object.sha;
  let comparisonStatus = "identical";
  if (currentSha !== requestedSha) {
    const comparison = await githubJson({
      apiUrl,
      token,
      path: `/repos/${repository}/compare/${requestedSha}...${currentSha}`,
    });
    comparisonStatus = comparison.status;
  }
  return planReleaseRoute({
    requestedSha,
    observedSha: currentSha,
    comparisonStatus,
    requestedChannel: inputs.channel,
    targetRef,
    dryRun: inputs["dry-run"] === true,
    resume:
      Boolean(inputs["resume-discussion-id"]) ||
      String(inputs["resume-candidate-run-id"] || "") !== "" ||
      inputs["publish-transaction-override"] === true,
  });
}

export async function observedSourceTimestamp(
  repository,
  sourceSha,
  { token, apiUrl },
) {
  const commit = await githubJson({
    apiUrl,
    token,
    path: `/repos/${repository}/git/commits/${sourceSha}`,
  });
  const observed = String(
    commit?.committer?.date || commit?.author?.date || "",
  ).trim();
  if (!observed || Number.isNaN(Date.parse(observed)))
    fail("protected publication source timestamp is unavailable");
  return new Date(observed).toISOString();
}
export async function observeProductPublicationRecovery(
  repository,
  sourceSha,
  candidateVersion,
  channel,
  { token, apiUrl },
) {
  const prefix = `heads/buildchain/v4-product-state/${sourceSha}-`;
  const stateRefs =
    (await githubJson({
      apiUrl,
      token,
      path: `/repos/${repository}/git/matching-refs/${prefix}`,
      allowNotFound: true,
    })) || [];
  const recoveryStates = await Promise.all(
    stateRefs.map(async (stateRef) => {
      const version = productStateVersion(stateRef, sourceSha);
      const [stateCommit, exactTagRef] = await Promise.all([
        githubJson({
          apiUrl,
          token,
          path: `/repos/${repository}/git/commits/${stateRef.object.sha}`,
        }),
        githubJson({
          apiUrl,
          token,
          path: `/repos/${repository}/git/ref/tags/v${version}`,
          allowNotFound: true,
        }),
      ]);
      return { stateRef, stateCommit, exactTagRef };
    }),
  );
  const exactTagRef = recoveryStates.length
    ? undefined
    : await githubJson({
        apiUrl,
        token,
        path: `/repos/${repository}/git/ref/tags/v${encodeURIComponent(channel === "stable" ? candidateVersion.replace(/-alpha\.\d+$/u, "") : candidateVersion)}`,
        allowNotFound: true,
      });
  return { recoveryStates, exactTagRef };
}
