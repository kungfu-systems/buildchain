// prettier-ignore
const { assert, assertOccurrences, fs, path, readRepoText, root, test } = await import("./build-surface-reusable-build-harness.mjs");
test("reusable build workflow exposes source, trust, and execution contracts", () => {
  const workflow = readRepoText(".github/workflows/.build.yml");
  const router = readRepoText(".github/workflows/build.yml");
  const summarizeJob = workflow.slice(
    workflow.indexOf("  summarize:"),
    workflow.indexOf(
      "\n  controller-receipt:",
      workflow.indexOf("  summarize:"),
    ),
  );
  const artifactDownloads =
    workflow.match(/uses: actions\/download-artifact@v7\.0\.0/g) || [];
  const authenticatedArtifactDownloads =
    workflow.match(
      /uses: actions\/download-artifact@v7\.0\.0\n\s+with:\n\s+github-token: \$\{\{ (?:github\.token|secrets\.BUILDCHAIN_PROMOTION_TOKEN) \}\}/g,
    ) || [];
  assert.match(workflow, /workflow_call:/);
  assert.equal(
    authenticatedArtifactDownloads.length,
    artifactDownloads.length,
    "every reusable-build artifact download must use the REST-backed token path so failed-job reruns can consume prior-attempt evidence",
  );
  assert.match(
    workflow,
    /artifact-signing-control:[\s\S]*?outputs:\n\s+source-run-attempt: \$\{\{ steps\.control-request\.outputs\.source-run-attempt \}\}/u,
  );
  assert.equal(
    (
      workflow.match(
        /needs\.artifact-signing-control\.outputs\.source-run-attempt/g,
      ) || []
    ).length,
    4,
    "failed-job reruns must finalize the exact source attempt retained by the signing controller",
  );
  assert.match(
    workflow,
    /control-runner-json:\n\s+description: "JSON runner-label array for trusted control-plane jobs"[\s\S]*?default: '\["ubuntu-24\.04"\]'/,
  );
  assert.match(
    workflow,
    /artifact-finalization-command:\n\s+description: "Optional consumer verification command over final artifact bytes before manifest resealing"/,
  );
  assert.match(
    workflow,
    /artifact-finalization-on-platform:\n\s+description: "Run trusted artifact finalization on each GitHub-hosted platform runner instead of the control runner"[\s\S]*?default: false[\s\S]*?type: boolean/,
  );
  assert.equal(
    (
      workflow.match(
        /runs-on: \$\{\{ fromJSON\(inputs\.control-runner-json\) \}\}/g,
      ) || []
    ).length,
    9,
  );
  assert.match(
    workflow,
    /fail-fast:\n\s+description: "Cancel sibling platform lanes[\s\S]*?default: false[\s\S]*?type: boolean/,
  );
  assertOccurrences(
    workflow,
    /strategy:\n\s+fail-fast: \$\{\{ inputs\.fail-fast \}\}/g,
    4,
  );
  assert.match(
    workflow,
    /kfd-agent-hub:\n\s+description: "Agent Hub conformance mode: off or auto/,
  );
  assert.equal(
    (workflow.match(/name: Run KFD Agent Hub conformance/g) || []).length,
    2,
  );
  assert.equal(
    (workflow.match(/name: Upload KFD Agent Hub evidence/g) || []).length,
    2,
  );
  assert.match(workflow, /buildchain\.mjs kfd hub test/);
  assert.match(
    workflow,
    /artifact-name \}\}-kfd-agent-hub-\$\{\{ matrix\.platform\.id \}\}/,
  );
  assert.match(
    workflow,
    /name: Resolve source-bound application identity[\s\S]*?loadCredentialInput[\s\S]*?sourceTreeSha: process\.env\.BUILDCHAIN_SOURCE_TREE_SHA/,
    "the credential island must derive product identity from the exact source-bound sealed manifest",
  );
  assert.match(
    workflow,
    /expected-bundle-id: \$\{\{ steps\.credential-identity\.outputs\.bundle-id \}\}/,
  );
  assert.doesNotMatch(
    workflow,
    /BUILDCHAIN_MACOS_EXPECTED_BUNDLE_ID/,
    "consumer repositories must not configure product bundle identity in the signing environment",
  );
  assert.match(workflow, /name: Validate consumer package manager contract/);
  assert.match(
    workflow,
    /validator=\.buildchain\/runtime\/scripts\/validate-package-manager-contract\.mjs/,
  );
  assert.match(
    workflow,
    /validator=\.buildchain\/workflow-shell\/scripts\/validate-package-manager-contract\.mjs/,
    "new workflow shells must retain package-manager validation when the selected stable runtime predates the validator",
  );
  assert.match(workflow, /node "\$\{validator\}"/);
  assert.match(
    workflow,
    /BUILDCHAIN_PACKAGE_MANAGER_CWD: \.buildchain\/consumer\n/,
    "consumer package-manager detection must use the repository root even when builds use a nested working directory",
  );
  assert.ok(
    workflow.indexOf("name: Validate consumer package manager contract") <
      workflow.indexOf("  build-native:"),
    "consumer package-manager incompatibility must fail before native release-candidate jobs",
  );
  assert.match(workflow, /  anchored-release-preflight:/);
  assert.match(workflow, /scripts\/anchored-version-material\.mjs/);
  assert.match(
    workflow,
    /verifier=\.buildchain\/runtime\/scripts\/anchored-version-material\.mjs/,
  );
  assert.match(
    workflow,
    /verifier=\.buildchain\/workflow-shell\/scripts\/anchored-version-material\.mjs/,
    "new workflow shells must retain the additive anchored preflight when the selected stable runtime predates its verifier",
  );
  assert.match(
    workflow,
    /install --dir \.buildchain\/workflow-shell --prod --frozen-lockfile --ignore-scripts/,
  );
  assert.match(
    workflow,
    /node "\$\{\{ steps\.anchored-verifier\.outputs\.path \}\}"/,
  );
  assert.match(
    summarizeJob,
    /name: Checkout Buildchain workflow shell for aggregate compatibility[\s\S]*?ref: \$\{\{ needs\.trust-gate\.outputs\.buildchain-workflow-shell-sha \}\}[\s\S]*?path: \.buildchain\/workflow-shell/,
  );
  assert.match(
    summarizeJob,
    /binder=\.buildchain\/runtime\/scripts\/resolve-artifact-coordinates\.mjs/,
  );
  assert.match(
    summarizeJob,
    /binder=\.buildchain\/workflow-shell\/scripts\/resolve-artifact-coordinates\.mjs/,
    "new workflow shells must retain producer artifact coordinates when the selected stable runtime predates the binder",
  );
  assert.match(
    summarizeJob,
    /node "\$\{\{ steps\.artifact-coordinate-binder\.outputs\.path \}\}"/,
  );
  assert.match(workflow, /kind":"anchored-version-material"/);
  assert.match(workflow, /target_ref="release\/\$\{BUILDCHAIN_TARGET_LINE\}"/);
  assert.ok(
    workflow.indexOf("  anchored-release-preflight:") <
      workflow.indexOf("  build-native:"),
    "anchored derived version material must be verified before heavy native builds",
  );
  assert.match(workflow, /runner-preset:/);
  assert.match(workflow, /platforms-json:/);
  assert.match(workflow, /self-hosted-offline-fallback:/);
  assert.match(
    workflow,
    /name: Route offline self-hosted lanes[\s\S]*?BUILDCHAIN_RUNNER_INVENTORY_TOKEN: \$\{\{ secrets\.BUILDCHAIN_PROMOTION_TOKEN \}\}/,
  );
  assert.match(
    workflow,
    /name: Checkout trusted runner-routing shell[\s\S]*?buildchain-workflow-shell-sha/,
  );
  assert.match(workflow, /runner-routing-json:/);
  assert.match(workflow, /linux-container-preset:/);
  assert.match(workflow, /linux-container-image:/);
  assert.match(workflow, /resolve-contract:/);
  assert.match(
    workflow,
    /fromJSON\(needs\.resolve-contract\.outputs\.native-platforms-json\)/,
  );
  assert.match(
    workflow,
    /fromJSON\(needs\.resolve-contract\.outputs\.container-platforms-json\)/,
  );
  assert.match(workflow, /Setup Buildchain Node\.js with fnm/);
  assert.match(workflow, /setup-rust:/);
  assert.match(workflow, /rust-toolchain:/);
  assert.match(workflow, /rustup-dist-server:/);
  assert.match(workflow, /rustup-update-root:/);
  assert.match(workflow, /cargo-registry-index:/);
  assert.equal((workflow.match(/RUSTUP_DIST_SERVER:/g) || []).length, 2);
  assert.equal((workflow.match(/RUSTUP_UPDATE_ROOT:/g) || []).length, 2);
  assert.match(workflow, /https:\/\/static\.rust-lang\.org\/rustup/);
  assert.match(workflow, /Setup Rust toolchain on Windows/);
  assert.match(
    workflow,
    /if: \$\{\{ inputs\.setup-rust && runner\.os == 'Windows' \}\}/,
  );
  assert.match(workflow, /shell: cmd/);
  assert.match(workflow, /curl\.exe --proto "=https"/);
  assert.match(workflow, /https:\/\/win\.rustup\.rs\/x86_64/);
  assert.match(workflow, /--no-modify-path/);
  assert.match(workflow, /buildchain-cargo/);
  assert.match(workflow, /buildchain-rustup/);
  assert.match(workflow, /Setup Rust toolchain/);
  assert.match(
    workflow,
    /if: \$\{\{ inputs\.setup-rust && runner\.os != 'Windows' \}\}/,
  );
  assert.match(
    workflow,
    /dtolnay\/rust-toolchain@4be7066ada62dd38de10e7b70166bc74ed198c30/,
  );
  assert.match(workflow, /toolchain: \$\{\{ inputs\.rust-toolchain \}\}/);
  assert.match(
    workflow,
    /CARGO_REGISTRIES_CRATES_IO_INDEX: \$\{\{ inputs\.cargo-registry-index \}\}/,
  );
  assert.match(workflow, /container:/);
  assert.match(workflow, /require-trusted-event:/);
  assert.match(workflow, /buildchain-ref:/);
  assert.match(workflow, /buildchain-contract-lock-path:/);
  assert.match(workflow, /buildchain-contract-compatibility-policy:/);
  assert.match(workflow, /buildchain-contract-drift-issue-mode:/);
  assert.match(workflow, /default: ""/);
  assert.match(workflow, /Resolve Buildchain runtime/);
  assert.match(workflow, /runtime-sha/);
  assert.match(workflow, /Checkout consumer contract lock/);
  assert.match(workflow, /buildchain-contract-lock\.mjs check/);
  assert.match(workflow, /BUILDCHAIN_WORKFLOW_SHELL_REF:/);
  assert.match(
    workflow,
    /BUILDCHAIN_EXPECTED_CHANNEL: \$\{\{ steps\.expected-identity\.outputs\.expected-channel \}\}/,
  );
  assert.match(
    workflow,
    /BUILDCHAIN_EXPECTED_MAJOR: \$\{\{ steps\.expected-identity\.outputs\.expected-major \}\}/,
  );
  assert.match(workflow, /BUILDCHAIN_ALLOW_OPAQUE_RUNTIME:/);
  assert.doesNotMatch(workflow, /contract-lock-compatible=true/);
  assert.match(workflow, /Report consumer Buildchain contract drift/);
  assert.match(workflow, /contract-lock-status=/);
  assert.match(
    workflow,
    /buildchain-ref override is only allowed for trusted workflow_dispatch runs/,
  );
  assert.match(workflow, /refs\/heads\/train\/vN\/vN\.M\/<capability>/);
  assert.match(workflow, /publish-channel:/);
  assert.match(workflow, /publish-refs-json:/);
  assert.match(workflow, /publish-source-ref:/);
  assert.match(workflow, /publish-anchor-request-json:/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name/);
  assert.match(workflow, /resolve-publish-gate\.mjs/);
  assert.match(workflow, /resolve-publish-source\.mjs --mode lock/);
  assert.match(workflow, /Verify publish target channel ref and PR lineage/);
  assert.match(workflow, /verify-publish-channel-ref\.mjs/);
  assert.ok(
    workflow.indexOf("Resolve publish source lock") <
      workflow.indexOf("Verify publish target channel ref and PR lineage"),
  );
  assert.ok(
    workflow.indexOf("Verify publish target channel ref and PR lineage") <
      workflow.indexOf("resolve-source:"),
  );
  assert.ok(
    workflow.indexOf("Verify publish target channel ref and PR lineage") <
      workflow.indexOf("build-native:"),
  );
  assert.ok(
    workflow.indexOf("Verify publish target channel ref and PR lineage") <
      workflow.indexOf("build-linux-container:"),
  );
  assert.ok(
    workflow.indexOf("Check Buildchain contract lock") <
      workflow.indexOf("build-native:"),
  );
  assert.match(workflow, /resolve-publish-source\.mjs --mode manifest/);
  assert.equal(
    (workflow.match(/Install Buildchain runtime dependencies/g) || []).length,
    7,
  );
  assertOccurrences(
    workflow,
    /pnpm@11\.7\.0 install --dir \.buildchain\/runtime --prod --frozen-lockfile --ignore-scripts/g,
    7,
  );
  assert.match(workflow, /install-command:/);
  assert.match(workflow, /build-command:/);
  assert.match(workflow, /verify-command:/);
  assert.match(workflow, /artifact-name:/);
  assert.match(workflow, /artifact-name-template:/);
  assert.match(workflow, /expected-artifacts-json:/);
  assert.equal(
    (workflow.match(/Seal declared artifact signing requests/g) || []).length,
    2,
  );
  assert.equal(
    (workflow.match(/Publish Buildchain-owned artifact signing request/g) || [])
      .length,
    2,
  );
  assert.equal(
    (workflow.match(/Seal detached signing control request/g) || []).length,
    2,
  );
  assert.equal(
    (workflow.match(/Publish detached signing control request/g) || []).length,
    2,
  );
  assertOccurrences(
    workflow,
    /Dispatch and await exact Buildchain signing authority/g,
    1,
  );
  assert.equal(
    (
      workflow.match(
        /Verify and import final signed bytes on GitHub-hosted infrastructure/g,
      ) || []
    ).length,
    1,
  );
  assert.doesNotMatch(workflow, /Download immutable signed result\n/);
  assert.equal(
    (workflow.match(/Publish signing finalization delegation/g) || []).length,
    1,
  );
  assert.match(
    workflow,
    /artifact-signing-control:[\s\S]*?runs-on: ubuntu-24\.04/,
  );
  assert.match(
    workflow,
    /artifact-signing-control:[\s\S]*?needs:[\s\S]*?- build-native[\s\S]*?- build-linux-container/,
  );
  assert.match(
    workflow,
    /finalize-artifact-signing:[\s\S]*?runs-on: \$\{\{ fromJSON\(inputs\.artifact-finalization-on-platform && matrix\.platform\.runner \|\| inputs\.control-runner-json\) \}\}/,
  );
  assert.match(
    workflow,
    /Enforce trusted platform-native finalization[\s\S]*?artifact-finalization-on-platform requires a GitHub-hosted platform runner/,
  );
});
