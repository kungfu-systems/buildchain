// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, materializeCommandShim, notFound, os, ownsMajorAlphaChannel, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, recordGitHubReleaseTransactionCompletion, releasePassportArtifactFiles, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, reuseCompleteGitHubReleaseEvidence, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, signedGeneratedCommitMessage, test, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");







test("invalid ref templates fail before lifecycle publish", async () => {
  for (const refTemplate of ["v{tag}", "v{version", "v{version}{version}"]) {
    const cwd = makeTempWorkspace({
      "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
      "package.json": {
        name: "@kungfu-tech/buildchain",
        version: "0.0.0-alpha.0",
        packageManager: "pnpm@11.7.0",
      },
      "scripts/publish.mjs": `
import fs from "node:fs";
fs.writeFileSync("publish-ran", "unexpected\\n");
`,
    });
    const { octokit } = createGitMock({
      refs: new Map([["heads/alpha/v1/v1.0", SHA]]),
    });

    await assert.rejects(
      () => promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "alpha/v1/v1.0",
        cwd,
        publishTransaction: true,
        publishRequiredArtifactsJson: JSON.stringify([{
          kind: "oci",
          name: "ghcr.io/kungfu-systems/build-images/base-linux",
          ref_template: refTemplate,
        }]),
      }),
      /ref_template/,
    );
    assert.equal(fs.existsSync(path.join(cwd, "publish-ran")), false);
  }
});

test("release publish transaction can promote existing npm artifacts by dist tag", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[publish]
mode = "promote-existing-version"
auth = "npm-token"
dist_tag = "latest"
package_set_order = "platforms-first-main-last"
main_package = "@kungfu-tech/buildchain"

[lifecycle.publish]
command = "node scripts/should-not-run.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0",
      packageManager: "pnpm@11.7.0",
    },
    ".buildchain/artifacts/build-summary.json": "/home/runner/work/buildchain/buildchain/.buildchain/artifacts/build-summary.json\n",
    "scripts/should-not-run.mjs": "throw new Error('lifecycle.publish should not run');\n",
  });
  const binDir = path.join(cwd, "bin");
  fs.mkdirSync(binDir);
  materializeCommandShim(
    path.join(binDir, "npm"),
    `#!/bin/sh
echo "$@" >> "$NPM_LOG"
if [ "$1" = "whoami" ]; then
  printf 'keren\\n'
  exit 0
fi
if [ "$1" = "view" ] && [ "$3" = "dist-tags.latest" ]; then
  printf '""\\n'
  exit 0
fi
if [ "$1" = "view" ] && [ "$3" = "dist.integrity" ]; then
  printf '"sha512-existing"\\n'
  exit 0
fi
if [ "$1" = "dist-tag" ] && [ "$2" = "add" ]; then
  exit 0
fi
exit 64
`,
  );

  const { octokit, refs, blobs, trees, commits } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", SHA],
      ["tags/v1.0.0-alpha.0", OTHER_SHA],
    ]),
  });
  const previousEnv = {
    PATH: process.env.PATH,
    NPM_LOG: process.env.NPM_LOG,
    NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
  };
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
  process.env.NPM_LOG = path.join(cwd, "npm.log");
  process.env.NODE_AUTH_TOKEN = "test-token";
  try {
    const result = await promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "release/v1/v1.0",
      cwd,
      publishTransaction: true,
      releasePassportProductName: "Libnode",
      releasePassportImpactJson: productionImpactJson(),
      publishRequiredArtifactsJson: JSON.stringify([
        {
          kind: "npm",
          name: "@kungfu-tech/buildchain-linux-x64",
          ref: "1.0.0",
          digest: "sha512-rebuilt",
          role: "platform",
          platform: "linux-x64",
        },
        {
          kind: "npm",
          name: "@kungfu-tech/buildchain-darwin-arm64",
          ref: "1.0.0",
          digest: "sha512-rebuilt",
          role: "platform",
          platform: "darwin-arm64",
        },
        {
          kind: "npm",
          name: "@kungfu-tech/buildchain-win32-x64",
          ref: "1.0.0",
          digest: "sha512-rebuilt",
          role: "platform",
          platform: "win32-x64",
        },
        {
          kind: "npm",
          name: "@kungfu-tech/buildchain",
          ref: "1.0.0",
          digest: "sha512-rebuilt",
          role: "main",
        },
      ]),
    });

    assert.equal(result.publishTransaction.state, "complete");
    assert.equal(refs.has("tags/v1.0.0"), true);
    const evidence = JSON.parse(
      fs.readFileSync(path.join(cwd, result.publishTransaction.evidencePath), "utf8"),
    );
    assert.deepEqual(evidence.artifacts, [
      {
        group: "",
        kind: "npm",
        name: "@kungfu-tech/buildchain-linux-x64",
        ref: "1.0.0",
        digest: "sha512-existing",
        role: "platform",
        required: true,
        platform: "linux-x64",
      },
      {
        group: "",
        kind: "npm",
        name: "@kungfu-tech/buildchain-darwin-arm64",
        ref: "1.0.0",
        digest: "sha512-existing",
        role: "platform",
        required: true,
        platform: "darwin-arm64",
      },
      {
        group: "",
        kind: "npm",
        name: "@kungfu-tech/buildchain-win32-x64",
        ref: "1.0.0",
        digest: "sha512-existing",
        role: "platform",
        required: true,
        platform: "win32-x64",
      },
      {
        group: "",
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0",
        digest: "sha512-existing",
        role: "main",
        required: true,
      },
    ]);
    assert.deepEqual(
      fs.readFileSync(process.env.NPM_LOG, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("dist-tag add")),
      [
        "dist-tag add @kungfu-tech/buildchain-linux-x64@1.0.0 latest",
        "dist-tag add @kungfu-tech/buildchain-darwin-arm64@1.0.0 latest",
        "dist-tag add @kungfu-tech/buildchain-win32-x64@1.0.0 latest",
        "dist-tag add @kungfu-tech/buildchain@1.0.0 latest",
      ],
    );
    assert.equal(result.publishTransaction.releasePassportPath, ".buildchain/release-passport/buildchain.release.json");
    assert.equal(result.publishTransaction.releasePassportOutputDir, ".buildchain/release-passport");
    assert.equal(refs.get("heads/buildchain/release-state/1-0-0"), result.publishTransaction.releasePassportStateSha);
    const stateCommit = commits.get(result.publishTransaction.releasePassportStateSha);
    const passportEntry = (trees.get(stateCommit.tree.sha) || []).find((entry) =>
      entry.path === "release-passport/buildchain.release.json"
    );
    assert.ok(passportEntry);
    const passport = JSON.parse(
      Buffer.from(blobs.get(passportEntry.sha).content, "base64").toString("utf8"),
    );
    assert.equal(passport.packageSet.platforms.length, 3);
    assert.equal(passport.product.name, "Libnode");
    assert.equal(passport.distTagPromotion.fields.distTag, "latest");
    assert.equal(passport.release.releaseStateRef, "refs/heads/buildchain/release-state/1-0-0");
    assert.match(passport.release.releaseStateSha, /^commit-\d+0+$/);
    assert.ok(commits.has(passport.release.releaseStateSha));
    assert.equal(stateCommit.parents[0].sha, passport.release.releaseStateSha);
    assert.equal(passport.buildSummary, undefined);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("release passport verification failure blocks durable passport persistence", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[publish]
mode = "promote-existing-version"
auth = "npm-token"
dist_tag = "latest"
main_package = "@kungfu-tech/buildchain"

[lifecycle.publish]
command = "node scripts/should-not-run.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0",
      packageManager: "pnpm@11.7.0",
    },
    ".buildchain/artifacts/build-summary.json": "/home/runner/work/buildchain/buildchain/.buildchain/artifacts/build-summary.json\n",
    "scripts/should-not-run.mjs": "throw new Error('lifecycle.publish should not run');\n",
  });
  const binDir = path.join(cwd, "bin");
  fs.mkdirSync(binDir);
  materializeCommandShim(
    path.join(binDir, "npm"),
    `#!/bin/sh
echo "$@" >> "$NPM_LOG"
if [ "$1" = "whoami" ]; then
  printf 'keren\\n'
  exit 0
fi
if [ "$1" = "view" ] && [ "$3" = "dist-tags.latest" ]; then
  printf '""\\n'
  exit 0
fi
if [ "$1" = "view" ] && [ "$3" = "dist.integrity" ]; then
  printf '"sha512-existing"\\n'
  exit 0
fi
if [ "$1" = "dist-tag" ] && [ "$2" = "add" ]; then
  exit 0
fi
exit 64
`,
  );

  const { octokit, refs, blobs, commits, trees } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", SHA],
      ["tags/v1.0.0-alpha.0", OTHER_SHA],
    ]),
  });
  const previousEnv = {
    PATH: process.env.PATH,
    NPM_LOG: process.env.NPM_LOG,
    NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
  };
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
  process.env.NPM_LOG = path.join(cwd, "npm.log");
  process.env.NODE_AUTH_TOKEN = "test-token";
  try {
    await assert.rejects(
      () => promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "release/v1/v1.0",
        cwd,
        publishTransaction: true,
        releasePassportProductName: "Libnode",
        publishRequiredArtifactsJson: JSON.stringify([
          {
            kind: "npm",
            name: "@kungfu-tech/buildchain",
            ref: "1.0.0",
            digest: "sha512-rebuilt",
            role: "main",
          },
        ]),
      }),
      /Release passport generated check failed.*impact\.surfaceImpacts\.required/,
    );

    const stateSha = refs.get("heads/buildchain/release-state/1-0-0");
    assert.ok(stateSha);
    const stateCommit = commits.get(stateSha);
    assert.ok(stateCommit);
    assert.deepEqual([JSON.parse(Buffer.from(blobs.get((trees.get(stateCommit.tree.sha) || []).find((entry) => entry.path === "state.json").sha).content, "base64")).state,
      (trees.get(stateCommit.tree.sha) || []).some((entry) =>
        entry.path === "release-passport/buildchain.release.json"
      ),
    ], ["finalizing", false],
    );
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
