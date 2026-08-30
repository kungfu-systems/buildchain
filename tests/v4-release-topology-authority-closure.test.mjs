import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  sealedCandidateVersion,
  selectProductPublicationPlan,
} from "../actions/v4-release-candidate-promote/product-provider.js";

const root = path.resolve(import.meta.dirname, "..");

test("recovered stable APPLY binds the release version to the sealed candidate", () => {
  assert.deepEqual(
    selectProductPublicationPlan(
      {
        updates: [
          {
            action: "dry-run-publish-transaction",
            version: "4.0.1",
            tag: "v4.0.1",
          },
        ],
      },
      { fallbackCandidateVersion: "4.0.1-alpha.56" },
    ),
    {
      version: "4.0.1",
      tag: "v4.0.1",
      candidateVersion: "4.0.1-alpha.56",
    },
  );
  assert.throws(
    () =>
      selectProductPublicationPlan(
        {
          updates: [
            {
              action: "dry-run-publish-transaction",
              version: "4.0.1",
              tag: "v4.0.1",
              releaseCandidateVersion: "4.0.1-alpha.55",
            },
          ],
        },
        { fallbackCandidateVersion: "4.0.1-alpha.56" },
      ),
    /drifted from the sealed candidate version/u,
  );
});

test("canonical APPLY recovers the candidate version from the sealed package manifest", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-sealed-version-"),
  );
  try {
    const manifest = path.join(temporaryRoot, "sealed-bundle.json");
    fs.writeFileSync(
      manifest,
      `${JSON.stringify({
        npm: {
          name: "@kungfu-tech/buildchain",
          version: "4.0.1-alpha.56",
        },
      })}\n`,
    );
    assert.equal(
      sealedCandidateVersion({
        sealedBundleManifest: manifest,
        publishPackageMain: "@kungfu-tech/buildchain",
      }),
      "4.0.1-alpha.56",
    );
    assert.throws(
      () =>
        sealedCandidateVersion({
          sealedBundleManifest: manifest,
          publishPackageMain: "@kungfu-tech/not-buildchain",
        }),
      /omitted the exact main package version/u,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("canonical APPLY activates the pnpm shim required by nested lifecycle scripts", () => {
  const provider = fs.readFileSync(
    path.join(root, "actions/v4-release-candidate-promote/product-provider.js"),
    "utf8",
  );
  assert.match(
    provider,
    /execFileSync\("corepack", \["enable", "pnpm"\], \{ stdio: "inherit" \}\);/u,
  );
  assert.match(
    provider,
    /const candidateVersion = sealedCandidateVersion\(request\);[\s\S]*promotionOptions\(request, \{ dryRun: true \}, candidateVersion\)/u,
  );
  assert.match(provider, /\}\s*,\s*plan\.candidateVersion,?\s*\),/u);
});

test("fork governance retains a credential-limited receipt without claiming authority", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/github-governance-audit.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /name: Mint bounded governance auditor token[\s\S]+KUNGFU_GOVERNANCE_AUDITOR_APP_PRIVATE_KEY != ''[\s\S]+continue-on-error: true/,
  );
  assert.match(
    workflow,
    /GH_TOKEN: \$\{\{ steps\.auditor\.outputs\.token \|\| secrets\.BUILDCHAIN_GOVERNANCE_READ_TOKEN \|\| github\.token \}\}/,
  );
  assert.match(
    workflow,
    /FORK_PULL_REQUEST:[\s\S]+github\.event\.pull_request\.head\.repo\.fork[\s\S]+Fork PR governance is credential-limited/,
  );
});

test("fork pull requests cannot enter the release fixture authority path", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/build-surface-fixture.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /libnode-shaped:\n    if: \$\{\{ github\.event_name != 'pull_request' \|\| !github\.event\.pull_request\.head\.repo\.fork \}\}/,
  );
});
