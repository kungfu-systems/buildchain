// prettier-ignore
const { assert, assertOccurrences, fs, path, readRepoText, root, test } = await import("./build-surface-reusable-build-harness.mjs");
test("reusable build workflow exposes signing and cache contracts", () => {
  const workflow = readRepoText(".github/workflows/.build.yml");
  const finalizationJob = workflow.slice(
    workflow.indexOf("  finalize-artifact-signing:"),
    workflow.indexOf(
      "\n  credential-island-macos:",
      workflow.indexOf("  finalize-artifact-signing:"),
    ),
  );
  assert.match(
    finalizationJob,
    /Download pre-signing deterministic artifact\n\s+uses:/,
  );
  assert.doesNotMatch(
    finalizationJob,
    /Download pre-signing deterministic artifact\n\s+if:/,
  );
  assert.match(
    finalizationJob,
    /Verify final artifact bytes with consumer policy/,
  );
  assert.match(finalizationJob, /BUILDCHAIN_ARTIFACT_SIGNING_STATE:/);
  assert.ok(
    finalizationJob.indexOf("Verify and import final signed bytes") <
      finalizationJob.indexOf(
        "Verify final artifact bytes with consumer policy",
      ) &&
      finalizationJob.indexOf(
        "Verify final artifact bytes with consumer policy",
      ) < finalizationJob.indexOf("Recompute manifest over final signed bytes"),
    "consumer final-byte verification must run after signed-byte import and before manifest resealing",
  );
  assert.match(
    workflow,
    /needs\.artifact-signing-control\.result == 'success'/,
  );
  assert.match(
    workflow,
    /needs\.finalize-artifact-signing\.result == 'success'/,
  );
  assert.equal(
    (workflow.match(/if \[ ! -f "\$\{signing_sealer\}" \]; then/g) || [])
      .length,
    2,
  );
  assertOccurrences(
    workflow,
    /if: \$\{\{ steps\.signing-requests\.outputs\.request-count != '0' \}\}/g,
    4,
  );
  assertOccurrences(
    workflow,
    /Artifact signing request sealing is unavailable in the resolved legacy runtime/g,
    2,
  );
  const firstBuild = workflow.indexOf("      - name: Run build lifecycle");
  const firstSeal = workflow.indexOf(
    "      - name: Seal declared artifact signing requests",
  );
  const firstVerify = workflow.indexOf("      - name: Run verify lifecycle");
  const signingControl = workflow.indexOf("  artifact-signing-control:");
  assert.ok(
    firstBuild < firstSeal && firstSeal < firstVerify,
    "unsigned requests must be sealed between build and verify",
  );
  assert.ok(
    firstVerify < signingControl,
    "the detached controller must be scheduled after the caller build jobs",
  );
  assert.doesNotMatch(
    workflow.slice(workflow.indexOf("  build-native:"), signingControl),
    /Dispatch and await exact Buildchain signing authority/u,
  );
  assert.match(
    workflow,
    /signing-request-\$\{\{ matrix\.platform\.id \}\}-\$\{\{ needs\.resolve-source\.outputs\.publish-source-sha \}\}/,
  );
  assert.match(workflow, /process-summary-path:/);
  assert.match(workflow, /sample-process-tree:/);
  assert.match(workflow, /process-sample-interval-ms:/);
  assert.match(workflow, /requested-parallelism:/);
  assert.match(workflow, /artifact-transfer-mode:/);
  assert.match(workflow, /artifact-signing-request-upload-no-proxy:/);
  assertOccurrences(
    workflow,
    /vars\.BUILDCHAIN_ARTIFACT_SIGNING_REQUEST_UPLOAD_NO_PROXY/g,
    2,
  );
  assert.equal(
    (workflow.match(/Resolve artifact signing request upload route/g) || [])
      .length,
    2,
  );
  assertOccurrences(
    workflow,
    /NO_PROXY: \$\{\{ steps\.signing-request-upload-route\.outputs\.no-proxy \}\}/g,
    2,
  );
  assert.match(workflow, /s3-to-github-artifacts/);
  assert.match(workflow, /artifact-relay-s3-bucket:/);
  assert.match(workflow, /artifact-relay-s3-region:/);
  assert.match(workflow, /BUILDCHAIN_ARTIFACT_RELAY_S3_BUCKET/);
  assert.match(workflow, /BUILDCHAIN_ARTIFACT_RELAY_S3_UPLOAD_ROLE_ARN/);
  assert.match(workflow, /BUILDCHAIN_ARTIFACT_RELAY_S3_DOWNLOAD_ROLE_ARN/);
  assert.match(workflow, /checkout-cache-mode:/);
  assert.match(workflow, /checkout-cache-mirror-url-template:/);
  assert.match(workflow, /checkout-cache-reference-repository-template:/);
  assert.match(workflow, /checkout-cache-fallback:/);
  assert.match(workflow, /checkout-cache-timeout-seconds:/);
  assert.match(workflow, /checkout-cache-github-timeout-seconds:/);
  assert.match(workflow, /checkout-cache-fetch-attempts:/);
  assert.match(workflow, /checkout-history-mode:/);
  assertOccurrences(
    workflow,
    /BUILDCHAIN_CHECKOUT_HISTORY_MODE: \$\{\{ inputs\.checkout-history-mode \}\}/g,
    2,
  );
  assert.match(workflow, /shifu-cache-profile-ref:/);
  assert.match(workflow, /shifu-cache-profile-digest:/);
  assert.match(workflow, /compiler-cache-provider:/);
  assert.match(workflow, /compiler-cache-platforms-json:/);
  assert.match(workflow, /compiler-cache-required:/);
  assert.equal((workflow.match(/SHIFU_CACHE_PROFILE_REF:/g) || []).length, 6);
  assert.equal(
    (workflow.match(/SHIFU_CACHE_PROFILE_DIGEST:/g) || []).length,
    8,
  );
  assert.equal(
    (workflow.match(/Prepare auditable compiler cache/g) || []).length,
    2,
  );
  assertOccurrences(
    workflow,
    /node \.buildchain\/runtime\/scripts\/compiler-cache-evidence\.mjs prepare/g,
    2,
  );
  assert.equal(
    (workflow.match(/Verify auditable compiler cache activity/g) || []).length,
    2,
  );
  assertOccurrences(
    workflow,
    /node \.buildchain\/runtime\/scripts\/compiler-cache-evidence\.mjs verify/g,
    2,
  );
  assert.equal(
    (
      workflow.match(
        /\.buildchain\/artifacts\/\$\{\{ matrix\.platform\.id \}\}\/compiler-cache-preparation\.json/g,
      ) || []
    ).length,
    5,
  );
  assert.equal(
    (workflow.match(/BUILDCHAIN_CHECKOUT_CACHE_GITHUB_TIMEOUT_SECONDS:/g) || [])
      .length,
    4,
  );
  assert.match(workflow, /BUILDCHAIN_CHECKOUT_CACHE_FETCH_ATTEMPTS:/);
  assert.match(workflow, /BUILDCHAIN_CHECKOUT_CACHE_MIRROR_URL_TEMPLATE/);
  assert.match(
    workflow,
    /BUILDCHAIN_CHECKOUT_CACHE_REFERENCE_REPOSITORY_TEMPLATE/,
  );
  assert.equal(
    (
      workflow.match(
        /node \.buildchain\/runtime\/scripts\/locked-source-checkout\.mjs/g,
      ) || []
    ).length,
    0,
  );
  assert.match(workflow, /buildchain-workflow-shell-sha:/);
  assert.match(workflow, /"workflow-shell-sha": workflowShellSha/);
  assert.match(workflow, /Checkout Buildchain workflow shell/);
  assert.match(
    workflow,
    /ref: \$\{\{ steps\.runtime\.outputs\.workflow-shell-sha \}\}/,
  );
  assert.match(
    workflow,
    /path: \|\n\s+\.buildchain\/workflow-shell\/scripts\/locked-source-checkout\.mjs/,
  );
  assert.match(
    workflow,
    /\.buildchain\/workflow-shell\/scripts\/artifact-signing-delegation\.mjs/,
  );
  assert.match(
    workflow,
    /\.buildchain\/workflow-shell\/scripts\/artifact-signing-controller\.mjs/,
  );
  assert.match(
    workflow,
    /\.buildchain\/workflow-shell\/scripts\/artifact-signing-controller-core\.mjs/,
  );
  assert.match(
    workflow,
    /\.buildchain\/workflow-shell\/scripts\/aws-runner-burst-core\.mjs/,
  );
  assert.match(
    workflow,
    /\.buildchain\/workflow-shell\/scripts\/aws-windows-jit-core\.mjs/,
  );
  assert.match(
    workflow,
    /\.buildchain\/workflow-shell\/scripts\/aws-macos-jit-core\.mjs/,
  );
  assert.doesNotMatch(
    fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "..",
        "scripts",
        "git-fetch-process-tree.mjs",
      ),
      "utf8",
    ),
    /from\s+["']\.\.\//,
    "the flattened runtime bootstrap must not import files outside scripts/",
  );
  assertOccurrences(
    workflow,
    /node \.buildchain\/runtime-bootstrap\/artifact-signing-delegation\.mjs seal/g,
    0,
  );
  assertOccurrences(
    workflow,
    /node \.buildchain\/runtime-bootstrap\/artifact-signing-controller\.mjs seal/g,
    2,
  );
  assert.match(workflow, /Upload Buildchain runtime checkout bootstrap/);
  assert.equal(
    (workflow.match(/Download Buildchain runtime checkout bootstrap/g) || [])
      .length,
    2,
  );
  assertOccurrences(
    workflow,
    /node \.buildchain\/runtime-bootstrap\/locked-source-checkout\.mjs/g,
    4,
  );
  assert.equal(
    (
      workflow.match(
        /BUILDCHAIN_SOURCE_CHECKOUT_PATH: \.buildchain\/runtime/g,
      ) || []
    ).length,
    2,
  );
  assert.equal(
    (
      workflow.match(
        /BUILDCHAIN_SOURCE_REPOSITORY: \$\{\{ inputs\.buildchain-repository \}\}/g,
      ) || []
    ).length,
    2,
  );
  assert.equal(
    (
      workflow.match(
        /BUILDCHAIN_SOURCE_CHECKOUT_DIAGNOSTICS_PATH: \.buildchain\/diagnostics\/runtime-checkout\.json/g,
      ) || []
    ).length,
    2,
  );
});

test("runtime bootstrap includes transitive GitHub output support", () => {
  assert.match(
    readRepoText(".github/workflows/.build.yml"),
    /\.buildchain\/workflow-shell\/scripts\/github-output\.mjs/,
  );
});
