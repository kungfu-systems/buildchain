#!/usr/bin/env node
import { runCandidateBodyPrefixRenderer } from "../../governance/candidate/body-renderer.js";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
function main() {
  const value = runCandidateBodyPrefixRenderer({
    environment: process.env,
    consumerRoot: process.env.BUILDCHAIN_CHANNEL_PATROL_CONSUMER_ROOT,
    renderer: process.env.BUILDCHAIN_CHANNEL_PATROL_PR_BODY_PREFIX_RENDERER,
    outputPath: process.env.BUILDCHAIN_CHANNEL_PATROL_PR_BODY_PREFIX_OUTPUT,
    selectedSha: process.env.BUILDCHAIN_CHANNEL_PATROL_SELECTED_SHA,
    sourceBranch: process.env.BUILDCHAIN_CHANNEL_PATROL_SOURCE_BRANCH,
    targetBranch: process.env.BUILDCHAIN_CHANNEL_PATROL_TARGET_BRANCH,
  });
  writeGitHubOutputs({ "pull-request-body-prefix": value });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
