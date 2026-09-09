import { nextDevelopmentWorkflowHeader } from "../../release/next-development-projection.js";
export function scaffoldBuildWorkflow(
  buildchainSha,
  { artifactName = "paper-publication" } = {},
) {
  return `${nextDevelopmentWorkflowHeader()}name: Build

on:
  workflow_dispatch:
  pull_request:
  push:
    branches:
      - "dev/**"
      - "alpha/**"
      - "release/**"

permissions:
  contents: read
  issues: write

jobs:
  publication:
    uses: kungfu-systems/buildchain/.github/workflows/public-build-publication.yml@${buildchainSha}
    with:
      buildchain-ref: ${buildchainSha}
      buildchain-contract-lock-path: .buildchain/contract-lock.json
      toolchain-type: config
      verify-command: make check
      artifact-name: ${JSON.stringify(artifactName)}
`;
}
export function scaffoldVerifyWorkflow(buildchainSha, buildchainVersion = "") {
  return `${nextDevelopmentWorkflowHeader()}name: Verify

on:
  pull_request:
  push:
    branches:
      - "dev/v*/v*"
      - "alpha/v*/v*"
      - "release/v*/v*"
  workflow_dispatch:

permissions:
${buildchainVersion.startsWith("4.") ? "  actions: read\n  contents: read\n  pull-requests: read" : "  contents: read"}

jobs:
  check:
    uses: kungfu-systems/buildchain/.github/workflows/public-build-check.yml@${buildchainSha}
    with:
      buildchain-ref: ${buildchainSha}
      require-version-state: true
      upload-artifacts: true
`;
}
export function scaffoldReleaseWorkflow(
  buildchainSha,
  { artifactPaths = "_build/main.pdf", releasePassportProductName = "" } = {},
) {
  const passportInput = releasePassportProductName
    ? `      release-passport-product-name: ${JSON.stringify(releasePassportProductName)}\n`
    : "";
  return `${nextDevelopmentWorkflowHeader()}name: Paper Release

on:
  workflow_dispatch:
  push:
    branches:
      - "alpha/**"
      - "release/**"

permissions:
  contents: read

jobs:
  paper-release:
    uses: kungfu-systems/buildchain/.github/workflows/public-release-paper.yml@${buildchainSha}
    permissions:
      actions: read
      checks: write
      contents: read
      id-token: write
      issues: write
      pull-requests: write
    with:
      buildchain-ref: ${buildchainSha}
      buildchain-contract-lock-path: .buildchain/contract-lock.json
      publisher-workflow-path: .github/workflows/public-release-paper.yml
      toolchain-type: config
      verify-command: make check
      artifact-paths: ${JSON.stringify(artifactPaths)}
${passportInput}    secrets:
      KUNGFU_GOVERNANCE_AUDITOR_APP_PRIVATE_KEY: \${{ secrets.KUNGFU_GOVERNANCE_AUDITOR_APP_PRIVATE_KEY }}
      BUILDCHAIN_GENERATED_WRITE_APP_CLIENT_ID: \${{ secrets.BUILDCHAIN_GENERATED_WRITE_APP_CLIENT_ID }}
      BUILDCHAIN_GENERATED_WRITE_APP_PRIVATE_KEY: \${{ secrets.BUILDCHAIN_GENERATED_WRITE_APP_PRIVATE_KEY }}
      BUILDCHAIN_GENERATED_WRITE_TOKEN: \${{ secrets.BUILDCHAIN_GENERATED_WRITE_TOKEN }}
      BUILDCHAIN_PROMOTION_TOKEN: \${{ secrets.BUILDCHAIN_PROMOTION_TOKEN }}
`;
}
