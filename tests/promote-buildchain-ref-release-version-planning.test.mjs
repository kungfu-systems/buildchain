// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, materializeCommandShim, notFound, os, ownsMajorAlphaChannel, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, recordGitHubReleaseTransactionCompletion, releasePassportArtifactFiles, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, reuseCompleteGitHubReleaseEvidence, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, signedGeneratedCommitMessage, test, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("governance maps channel targets to the only legal PR source", () => {
  assert.equal(expectedHeadRefForTarget("alpha/v1/v1.0"), "dev/v1/v1.0");
  assert.equal(expectedHeadRefForTarget("release/v1/v1.0"), "alpha/v1/v1.0");
  assert.equal(expectedHeadRefForTarget("publish-gate/major"), "release/vN/vN.M");
  assert.equal(expectedHeadRefForTarget("major-gate"), "release/vN/vN.M");
  assert.deepEqual(parseReleaseLineRef("release/v1/v1.0"), {
    ref: "release/v1/v1.0",
    major: 1,
    minor: 0,
  });
  assert.deepEqual(
    latestAlphaForPatch(
      [
        { ref: "refs/tags/v1.0.2-alpha.0", object: { sha: SHA } },
        { ref: "refs/tags/v1.0.2-alpha.1", object: { sha: OTHER_SHA } },
        { ref: "refs/tags/v1.0.3-alpha.0", object: { sha: "c".repeat(40) } },
      ],
      "v1.0",
      2,
    ),
    { tag: "v1.0.2-alpha.1", patch: 2, prerelease: 1, sha: OTHER_SHA },
  );
});

test("release line dry-run explains alpha promotion semantics", () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "fixture",
      version: "2.0.0-alpha.0",
    },
  });
  const plan = explainReleaseLineDryRun({
    cwd,
    targetRef: "alpha/v2/v2.0",
    sha: SHA,
  });

  assert.equal(plan.channel, "alpha");
  assert.equal(plan.source.expectedHeadRef, "dev/v2/v2.0");
  assert.deepEqual(plan.branchUpdates.map((update) => update.ref), [
    "alpha/v2/v2.0",
    "dev/v2/v2.0",
  ]);
  assert.deepEqual(plan.floatingRefs.map((update) => update.ref), ["v2.0-alpha", "v2-alpha"]);
  assert.match(formatReleaseLineDryRun(plan), /No refs, tags, packages, or files were modified/);
});

test("release line dry-run explains production and next-alpha semantics", () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `schema = 1

[version]
required = true

[[version.files]]
path = "VERSION"
type = "regex"
pattern = "VERSION=(?<version>[^\\n]+)"
replacement = "VERSION={{version}}"
`,
    VERSION: "VERSION=2.0.1-alpha.0\n",
  });
  const plan = explainReleaseLineDryRun({
    cwd,
    targetRef: "release/v2/v2.0",
    sha: SHA,
    tags: ["v2.0.1", "v2.0.2-alpha.0"],
    publishTransaction: true,
  });

  assert.equal(plan.channel, "release");
  assert.deepEqual(plan.exactTags.map((tag) => tag.tag), ["v2.0.1", "v2.0.2-alpha.0"]);
  assert.deepEqual(plan.floatingRefs.map((update) => update.ref), ["v2.0", "v2", "v2.0-alpha", "v2-alpha"]);
  assert.equal(plan.publishTransaction.enabled, true);
  assert.equal(plan.versionState.manager, "buildchain.toml");
  assert.deepEqual(plan.versionState.files, ["VERSION"]);
  assert.match(plan.governanceChecks.join("\n"), /same-patch exact alpha tag tree/);
});

test("release line dry-run resolves major gate from explicit source ref", () => {
  const plan = explainReleaseLineDryRun({
    cwd: makeTempWorkspace({}),
    targetRef: "publish-gate/major",
    sourceRef: "release/v2/v2.0",
    sha: SHA,
  });

  assert.equal(plan.channel, "major");
  assert.equal(plan.line, "v3.0");
  assert.deepEqual(plan.exactTags.map((tag) => tag.tag), ["v3.0.0", "v3.0.1-alpha.0"]);
  assert.deepEqual(plan.branchUpdates.map((update) => update.ref), [
    "publish-gate/major",
    "release/v3/v3.0",
    "alpha/v3/v3.0",
    "dev/v3/v3.0",
  ]);
});

test("selectReleaseTag creates, increments, and reuses canonical v-prefixed release tags", () => {
  assert.deepEqual(
    selectReleaseTag({ refs: [], releasePrefix: "v1.0", sha: SHA }),
    {
      tag: "v1.0.0",
      patch: 0,
      exists: false,
    },
  );
  assert.deepEqual(
    selectReleaseTag({
      refs: [
        { ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } },
        { ref: "refs/tags/v1.0.1", object: { sha: SHA } },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.1", patch: 1, exists: true },
  );
  assert.deepEqual(
    selectReleaseTag({
      refs: [
        { ref: "refs/tags/1.0.99", object: { sha: OTHER_SHA } },
        { ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } },
        {
          ref: "refs/heads/buildchain/release-state/1-0-1",
          object: { sha: OTHER_SHA },
        },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.2", patch: 2, exists: false },
  );
});

test("selectAlphaTag creates ABV-style prerelease tags for the minor line", () => {
  assert.deepEqual(
    selectAlphaTag({ refs: [], releasePrefix: "v1.0", sha: SHA }),
    {
      tag: "v1.0.0-alpha.0",
      patch: 0,
      prerelease: 0,
      exists: false,
    },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [{ ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } }],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.1-alpha.0", patch: 1, prerelease: 0, exists: false },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [
        { ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } },
        { ref: "refs/tags/v1.0.1-alpha.0", object: { sha: OTHER_SHA } },
        {
          ref: "refs/heads/buildchain/release-state/1-0-1",
          object: { sha: OTHER_SHA },
        },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.2-alpha.0", patch: 2, prerelease: 0, exists: false },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [
        {
          ref: "refs/heads/buildchain/release-state/1-0-1-alpha-0",
          object: { sha: OTHER_SHA },
        },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.1-alpha.1", patch: 1, prerelease: 1, exists: false },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [{ ref: "refs/tags/v1.0.1-alpha.0", object: { sha: SHA } }],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    {
      tag: "v1.0.1-alpha.0",
      patch: 1,
      prerelease: 0,
      sha: SHA,
      exists: true,
    },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [
        { ref: "refs/tags/v1.0.0-alpha.0", object: { sha: SHA } },
        { ref: "refs/tags/v1.0.1-alpha.0", object: { sha: OTHER_SHA } },
        { ref: "refs/tags/v1.0.1-alpha.1", object: { sha: "b".repeat(40) } },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
      patchAfterRelease: 1,
    }),
    {
      tag: "v1.0.1-alpha.1",
      patch: 1,
      prerelease: 1,
      sha: "b".repeat(40),
      exists: true,
    },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [
        {
          ref: "refs/heads/buildchain/release-state/1-0-1-alpha-0",
          object: { sha: OTHER_SHA },
        },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
      patchAfterRelease: 1,
    }),
    { tag: "v1.0.1-alpha.1", patch: 1, prerelease: 1, exists: false },
  );
});

test("discoverVersionStateFiles follows package-manager workspace metadata", () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-systems/example",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "pnpm-workspace.yaml": 'packages:\n  - "actions/*"\n',
    "actions/one/package.json": {
      name: "@kungfu-systems/one",
      version: "1.0.0-alpha.0",
    },
    "actions/no-version/package.json": {
      name: "@kungfu-systems/no-version",
      private: true,
    },
  });

  const discovered = discoverVersionStateFiles(cwd);

  assert.equal(discovered.packageManager.name, "pnpm");
  assert.deepEqual(
    discovered.files.map((file) => file.path),
    ["actions/one/package.json", "package.json"],
  );
  assert.deepEqual(
    updateVersionStateContents(discovered.files, "1.0.1").map((file) => file.path),
    ["actions/one/package.json", "package.json"],
  );
});

test("discoverVersionStateFiles prefers buildchain.toml version state", () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "toml"
path = "pyproject.toml"
key = "project.version"
`,
    "package.json": {
      name: "@kungfu-systems/example",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "pyproject.toml": '[project]\nname = "example"\nversion = "1.0.0-alpha.0"\n',
  });

  const discovered = discoverVersionStateFiles(cwd);

  assert.equal(discovered.packageManager.name, "buildchain.toml");
  assert.deepEqual(discovered.files.map((file) => file.path), ["pyproject.toml"]);
  const changed = updateVersionStateContents(discovered.files, "1.0.1");
  assert.equal(changed.length, 1);
  assert.match(changed[0].content, /version = "1.0.1"/);
});

test("version verification allows only discovered version-state file changes", () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-systems/example",
      version: "1.0.0-alpha.0",
    },
    "actions/one/package.json": {
      name: "@kungfu-systems/one",
      version: "1.0.0-alpha.0",
    },
    "README.md": "fixture\n",
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], cwd);

  fs.writeFileSync(
    path.join(cwd, "actions/one/package.json"),
    JSON.stringify({ name: "@kungfu-systems/one", version: "1.0.1-alpha.0" }, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(cwd, "README.md"), "changed\n");

  assert.throws(
    () => assertAllowedLocalChanges(cwd, ["actions/one/package.json"]),
    /README\.md/,
  );
  fs.writeFileSync(path.join(cwd, "README.md"), "fixture\n");
  assert.doesNotThrow(() =>
    assertAllowedLocalChanges(cwd, ["actions/one/package.json"]),
  );
});

test("version verification ignores generated buildchain evidence", () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-systems/example",
      version: "1.0.0-alpha.0",
    },
    "README.md": "fixture\n",
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], cwd);

  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "@kungfu-systems/example", version: "1.0.1-alpha.0" }, null, 2) + "\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/release-candidate/passport"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/release-candidate/passport/release-candidate-passport.json"),
    "{}\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/kfd/kfd-1"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".buildchain/kfd/kfd-2/claims"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/kfd/kfd-1/contract-world.witness.json"),
    "{}\n",
  );
  fs.writeFileSync(
    path.join(cwd, ".buildchain/kfd/kfd-2/claims/buildchain-npm-publish-evidence.json"),
    "{}\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/release-evidence/v1.0.1"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/release-evidence/v1.0.1/evidence.json"),
    "{}\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/release-passport"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/release-passport/buildchain.release.json"),
    "{}\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/release-state"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/release-state/v1.0.1.json"),
    "{}\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/release-tail"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/release-tail/release-transaction.json"),
    "{}\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/runtime/actions/promote-buildchain-ref"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/runtime/actions/promote-buildchain-ref/action.yml"),
    "name: runtime\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/contract-drift"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/contract-drift/issue-body.md"),
    "# compatible drift\n",
  );
  fs.writeFileSync(
    path.join(cwd, ".buildchain/publication-result.json"),
    "{}\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/recovered-publication/1.0.1"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/recovered-publication/1.0.1/product-payload-manifest.json"),
    "{}\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/admitted/artifact/.buildchain/publication"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/admitted/artifact/.buildchain/publication/publication-artifact.json"),
    "{}\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/admitted/controller"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/admitted/controller/receipt.json"),
    "{}\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/controller"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/controller/plan.json"),
    "{}\n",
  );

  assert.doesNotThrow(() => assertAllowedLocalChanges(cwd, ["package.json"]));

  fs.writeFileSync(
    path.join(cwd, ".buildchain/publication-result.json.backup"),
    "{}\n",
  );
  assert.throws(() => assertAllowedLocalChanges(cwd, ["package.json"]), /\.buildchain\/publication-result\.json\.backup/);
  fs.rmSync(path.join(cwd, ".buildchain/publication-result.json.backup"));

  fs.writeFileSync(path.join(cwd, ".buildchain/other.json"), "{}\n");
  assert.throws(
    () => assertAllowedLocalChanges(cwd, ["package.json"]),
    /\.buildchain\/other\.json/,
  );
});

test("version verification allows only the exact self-runtime dependency bridge", () => {
  const cwd = makeTempWorkspace({ "package.json": { name: "example", version: "1.0.0" } });
  run(["git", "init"], cwd);
  fs.writeFileSync(path.join(cwd, ".git/info/exclude"), "node_modules/\n");
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], cwd);
  const bridge = path.join(cwd, "node_modules");
  fs.mkdirSync(path.join(cwd, ".buildchain/runtime/node_modules"), { recursive: true });
  fs.symlinkSync(path.join(cwd, ".buildchain/runtime/node_modules"), bridge, "junction");
  assert.doesNotThrow(() => assertAllowedLocalChanges(cwd, ["package.json"]));
  fs.unlinkSync(bridge);
  fs.symlinkSync(path.join(cwd, ".buildchain/runtime"), bridge, "junction");
  assert.throws(() => assertAllowedLocalChanges(cwd, ["package.json"]), /\?\? node_modules/);
  fs.rmSync(path.join(cwd, ".buildchain/runtime"), { recursive: true });
  assert.throws(() => assertAllowedLocalChanges(cwd, ["package.json"]), /\?\? node_modules/);
});

test("version-state lifecycle can materialize declared derived files before verification", () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[[version.files]]
type = "json"
path = "dist/site/buildchain-contract.json"
key = "product.version"

[lifecycle.version-state]
command = "node scripts/generate-site-contract.mjs"

[lifecycle.verify]
command = "node scripts/check-site-contract.mjs"
`,
    "package.json": {
      name: "@kungfu-systems/example",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "dist/site/buildchain-contract.json": {
      product: { version: "1.0.0-alpha.0" },
      generated: false,
    },
    "scripts/generate-site-contract.mjs": `
import fs from "node:fs";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
fs.writeFileSync("dist/site/buildchain-contract.json", JSON.stringify({
  product: { version: pkg.version },
  generated: true
}, null, 2) + "\\n");
`,
    "scripts/check-site-contract.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const contract = JSON.parse(fs.readFileSync("dist/site/buildchain-contract.json", "utf8"));
assert.equal(contract.product.version, pkg.version);
assert.equal(contract.generated, true);
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], cwd);

  const discovered = discoverVersionStateFiles(cwd);
  const changedFiles = updateVersionStateContents(discovered.files, "1.0.1-alpha.0");
  const verifiedChangedFiles = runVersionVerification({
    cwd,
    loadedConfig: discovered.config,
    version: "1.0.1-alpha.0",
    changedFiles,
    allowedPaths: discovered.files.map((file) => file.path),
  });

  assert.deepEqual(
    verifiedChangedFiles.map((file) => file.path),
    ["dist/site/buildchain-contract.json", "package.json"],
  );
  const contract = JSON.parse(
    verifiedChangedFiles.find((file) => file.path === "dist/site/buildchain-contract.json").content,
  );
  assert.deepEqual(contract, {
    product: { version: "1.0.1-alpha.0" },
    generated: true,
  });
});
