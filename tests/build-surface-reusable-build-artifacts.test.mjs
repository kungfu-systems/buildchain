// prettier-ignore
const { assert, assertOccurrences, fs, path, readRepoText, root, test } = await import("./build-surface-reusable-build-harness.mjs");
test("reusable build workflow exposes artifact and summary contracts", () => {
  const workflow = readRepoText(".github/workflows/.build.yml");
  const router = readRepoText(".github/workflows/build.yml");
  const nativeJob = workflow.slice(
    workflow.indexOf("\n  build-native:"),
    workflow.indexOf("\n  build-linux-container:"),
  );
  const containerJob = workflow.slice(
    workflow.indexOf("\n  build-linux-container:"),
    workflow.indexOf("\n  relay-artifacts:"),
  );
  assert.ok(
    nativeJob.indexOf("Setup Node.js") <
      nativeJob.indexOf("Download Buildchain runtime checkout bootstrap"),
  );
  assert.ok(
    containerJob.indexOf("Setup Buildchain Node.js") <
      containerJob.indexOf("Download Buildchain runtime checkout bootstrap"),
  );
  for (const job of [nativeJob, containerJob]) {
    assert.ok(
      job.indexOf("Download Buildchain runtime checkout bootstrap") <
        job.indexOf("Checkout Buildchain runtime"),
    );
    assert.doesNotMatch(
      job,
      /Checkout Buildchain runtime\n\s+uses: actions\/checkout/,
    );
  }
  assert.equal(
    (
      workflow.match(
        /BUILDCHAIN_SOURCE_CHECKOUT_DIAGNOSTICS_PATH: \.buildchain\/diagnostics\/source-checkout\.json/g,
      ) || []
    ).length,
    2,
  );
  assert.equal(
    (
      workflow.match(
        /\.buildchain\/artifacts\/\$\{\{ matrix\.platform\.id \}\}\/source-checkout\.json/g,
      ) || []
    ).length,
    5,
  );
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /artifact-transfer:/);
  assert.match(workflow, /INPUT_RELAY_REQUIRED:/);
  assert.match(workflow, /github-hosted-platform-ids-json:/);
  assert.match(workflow, /artifact-relay-s3\.mjs upload/);
  assert.match(workflow, /artifact-relay-s3\.mjs download/);
  assert.match(workflow, /artifact-relay-s3\.mjs cleanup/);
  assert.match(workflow, /aws-actions\/configure-aws-credentials@v6\.1\.0/);
  assert.match(
    workflow,
    /artifact-name \}\}-relay-manifest-\$\{\{ matrix\.platform\.id \}\}-/,
  );
  assert.match(workflow, /relay-artifacts:/);
  assert.match(
    workflow,
    /needs\.artifact-transfer\.outputs\.mode == 'github-artifacts'/,
  );
  assert.match(
    workflow,
    /needs\.artifact-transfer\.outputs\.mode == 's3-to-github-artifacts'/,
  );
  assert.match(
    workflow,
    /needs\.artifact-transfer\.outputs\.mode == 'github-artifacts' \|\| matrix\.platform\.githubHosted == true/,
  );
  assert.match(
    workflow,
    /needs\.artifact-transfer\.outputs\.mode == 's3-to-github-artifacts' && matrix\.platform\.githubHosted != true/,
  );
  const deterministicPayloadUploads = [
    ...workflow.matchAll(
      /\n      - name: (?:Upload|Publish final(?: signed)?) deterministic artifact\n([\s\S]*?)(?=\n      - name:|\n  [a-z])/g,
    ),
  ];
  assert.equal(deterministicPayloadUploads.length, 4);
  for (const [, uploadStep] of deterministicPayloadUploads) {
    assert.match(uploadStep, /include-hidden-files: true/);
  }
  const relayJob = workflow.slice(
    workflow.indexOf("\n  relay-artifacts:"),
    workflow.indexOf("\n  artifact-signing-control:"),
  );
  assert.equal(
    (
      relayJob.match(
        /if: \$\{\{ matrix\.platform\.githubHosted != true \}\}/g,
      ) || []
    ).length,
    9,
  );
  assert.match(workflow, /process-summary-required:/);
  assert.match(workflow, /manifest\.json/);
  assert.match(workflow, /summary\.json/);
  assert.match(workflow, /diagnostics\.json/);
  assert.match(workflow, /diagnostics-manifest\.json/);
  assert.match(workflow, /source-checkout\.json/);
  assert.match(workflow, /events\.jsonl/);
  assert.match(workflow, /process-summary\.json/);
  assert.match(workflow, /process-samples\.jsonl/);
  assert.match(workflow, /-diagnostics-\$\{\{ matrix\.platform\.id \}\}-/);
  assert.match(workflow, /build-summary-artifact:/);
  assert.match(workflow, /build-diagnostics-summary-artifact:/);
  assert.match(workflow, /release-candidate-artifact:/);
  assert.match(workflow, /diagnostics-summary-artifact-name:/);
  assert.match(workflow, /build-diagnostics-summary-json:/);
  assert.match(workflow, /diagnostics contract warning/);
  assert.match(workflow, /sidecar manifest warning totals/);
  assert.match(workflow, /downloaded-diagnostics/);
  assert.match(workflow, /BUILDCHAIN_RUNTIME_SHA/);
  assert.match(workflow, /BUILDCHAIN_RUNTIME_TRUST_DECISION/);
  assert.match(workflow, /BUILDCHAIN_CONTRACT_LOCK_PATH/);
  assert.match(workflow, /aggregate-diagnostics-summary\.mjs/);
  assert.match(workflow, /generate-release-candidate-passport\.mjs/);
  assert.match(workflow, /release-candidate-enabled/);
  assert.match(
    workflow,
    /BUILDCHAIN_RC_TARGET_CHANNEL: \$\{\{ needs\.resolve-source\.outputs\.publish-source-channel \|\| needs\.trust-gate\.outputs\.publish-channel \}\}/,
  );
  assert.match(
    workflow,
    /BUILDCHAIN_RC_PR_BASE_REF: \$\{\{ github\.base_ref \|\| github\.event\.pull_request\.base\.ref \}\}/,
  );
  assert.match(
    workflow,
    /resolve-build-summary-names\.sh/,
  );
  assert.match(
    workflow,
    /if: \$\{\{ steps\.names\.outputs\.release-candidate-enabled == 'true' \}\}/,
  );
  assert.match(
    workflow,
    /BUILDCHAIN_RC_TARGET_CHANNEL: \$\{\{ steps\.names\.outputs\.release-candidate-target-channel \}\}/,
  );
  assert.match(workflow, /diagnostics-summary\.json/);
  assert.match(
    workflow,
    /\$\{\{ inputs\.artifact-name \}\}-release-candidate-\$\{\{ needs\.resolve-source\.outputs\.publish-source-sha \}\}/,
  );
  assert.match(workflow, /generate-release-candidate-passport\.mjs/);
  assert.match(
    workflow,
    /-diagnostics-summary-\$\{\{ needs\.resolve-source\.outputs\.publish-source-sha \}\}/,
  );
  assert.match(workflow, /Upload aggregate diagnostics summary/);
  assert.equal(
    (
      workflow.match(
        /manifest-artifact-name: \$\{\{ inputs\.artifact-name \}\}-manifest-\$\{\{ matrix\.platform\.id \}\}-\$\{\{ needs\.resolve-source\.outputs\.publish-source-sha \}\}/g,
      ) || []
    ).length,
    2,
  );
  assert.equal(
    (
      workflow.match(
        /diagnostics-artifact-name: \$\{\{ inputs\.artifact-name \}\}-diagnostics-\$\{\{ matrix\.platform\.id \}\}-\$\{\{ needs\.resolve-source\.outputs\.publish-source-sha \}\}/g,
      ) || []
    ).length,
    2,
  );
  assert.equal(
    (
      workflow.match(
        /process-summary-path: \$\{\{ inputs\.process-summary-path \|\| \(inputs\.sample-process-tree && '\.buildchain\/diagnostics\/process-summary\.json'\) \|\| '' \}\}/g,
      ) || []
    ).length,
    4,
  );
  assert.equal(
    (
      workflow.match(
        /sample-process-tree: \$\{\{ inputs\.sample-process-tree \}\}/g,
      ) || []
    ).length,
    2,
  );
  assert.equal(
    (
      workflow.match(
        /process-summary-required: \$\{\{ inputs\.require-build \}\}/g,
      ) || []
    ).length,
    2,
  );
  assert.equal(
    (
      workflow.match(
        /process-summary-required: \$\{\{ inputs\.process-summary-path != '' \|\| inputs\.require-build \}\}/g,
      ) || []
    ).length,
    2,
  );
  assert.match(workflow, /publish-allowed:/);
  assert.match(workflow, /publish-reason:/);
  assert.match(workflow, /publish-source-sha:/);
  assert.match(workflow, /release-manifest-json:/);
  assert.equal(
    (
      workflow.match(
        /artifact-summary-json: \$\{\{ steps\.summary\.outputs\.artifact-summary-json \}\}/g,
      ) || []
    ).length,
    1,
  );
  assert.match(
    workflow,
    /BUILDCHAIN_SOURCE_SHA: \$\{\{ needs\.resolve-source\.outputs\.publish-source-sha \}\}/,
  );
  assert.match(workflow, /actions\/upload-artifact@v7\.0\.1/);
  assert.match(workflow, /artifact-compression-level:/);
  assert.match(workflow, /default: 0/);
  assert.equal(
    (
      workflow.match(
        /name: Upload deterministic artifact[\s\S]*?compression-level: \$\{\{ inputs\.artifact-compression-level \}\}/g,
      ) || []
    ).length,
    3,
  );
  assert.match(
    router,
    /artifact-compression-level: \$\{\{ inputs\.artifact-compression-level \}\}/,
  );
});
