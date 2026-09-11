import { retryGitHubOperation } from "./github-adapter.js";
import { isManagedChannelBranch } from "./branch-protection.js";
export function assertExpectedPublicationVersion(
  expectedVersion,
  actualVersion,
) {
  const expected = String(expectedVersion || "").trim();
  const actual = String(actualVersion || "").trim();
  if (expected && expected !== actual) {
    throw new Error(
      `publication version changed after authority planning: expected ${expected}, got ${actual || "<empty>"}`,
    );
  }
  return actual;
}
export function protectedBranchUpdateRejected(error) {
  const status = error?.status || error?.response?.status;
  const message = error?.response?.data?.message || error?.message || "";
  return (
    status === 422 &&
    /Changes must be made through a pull request|Required status check|approving review is required/i.test(
      message,
    )
  );
}
export function protectedBranchDirectUpdateError({ branch, branchSha, error }) {
  const message =
    error?.response?.data?.message || error?.message || String(error || "");
  return new Error(
    `Buildchain generated version-state update for ${branch} -> ${branchSha} was rejected by branch protection: ${message}. ` +
      "The promotion caller must enable Buildchain's protected version-state PR fallback or use an explicitly admitted release authority; do not weaken branch protection or bypass the repository's declared governance.",
  );
}
export async function createGeneratedVersionStateChecks({
  octokit,
  owner,
  repo,
  branch,
  branchSha,
  currentSha,
  requiredStatusCheck,
  requiredStatusChecks = [],
}) {
  if (!isManagedChannelBranch(branch)) {
    return [];
  }
  const statusChecks = [
    ...new Set(
      [...requiredStatusChecks, requiredStatusCheck]
        .map((check) => String(check || "").trim())
        .filter(Boolean)
        .map((name) =>
          /^(?:dev|alpha|release)\/v4\//u.test(branch)
            ? `Version-state projection / ${name}`
            : name,
        ),
    ),
  ];
  if (statusChecks.length === 0) {
    return [];
  }
  if (typeof octokit?.rest?.checks?.create !== "function") {
    console.log(
      `buildchain: unable to create generated version-state checks '${statusChecks.join(", ")}' for ${branchSha}; checks.create is unavailable`,
    );
    return [];
  }
  for (const statusCheck of statusChecks) {
    await retryGitHubOperation(
      `checks.create ${statusCheck} ${branchSha}`,
      () =>
        octokit.rest.checks.create({
          owner,
          repo,
          name: statusCheck,
          head_sha: branchSha,
          status: "completed",
          conclusion: "success",
          output: {
            title: "Buildchain generated version-state verification",
            summary:
              `Buildchain verified generated version-state commit ${branchSha} for ${branch} before direct protected ref update.\n\n` +
              `Previous branch head: ${currentSha || "new branch"}\n\n` +
              "This check is emitted only after promote-buildchain-ref has generated the commit through the declared version-state files and verification gate.",
          },
        }),
    );
  }
  return statusChecks;
}
export function versionStateBranchName(branch, sha) {
  return `buildchain/version-state/${branch.replaceAll("/", "-")}/${sha.slice(0, 12)}`;
}
