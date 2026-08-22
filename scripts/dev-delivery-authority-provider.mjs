import { settleDevDeliveryAuthorityCandidateWithGitHubProvider } from "../packages/core/dev-delivery-authority-landing.js";

export function settleDevDeliveryAuthorityWithProvider(state, options) {
  return settleDevDeliveryAuthorityCandidateWithGitHubProvider(
    state,
    {
      pullRequestNumber: options.pullRequestNumber,
      sourceHead: options.sourceHead,
      outcome: options.outcome,
      evidenceRoot: options.evidenceRoot,
      reason: options.reason,
      authorityToken: options.authorityToken,
      authorityGeneration: options.authorityGeneration,
      transferRoot: options.transferRoot,
      finalizerBoundaryRoot: options.finalizerBoundaryRoot,
      nativeJobId: options.nativeJobId,
      sealJobId: options.sealJobId,
    },
    {
      now: options.now,
      token: options.token || process.env.GITHUB_TOKEN,
      apiUrl:
        options.apiUrl ||
        process.env.GITHUB_API_URL ||
        "https://api.github.com",
    },
  );
}
