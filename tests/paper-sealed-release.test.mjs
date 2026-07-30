import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("sealed paper release separates read-only build, authority, and admitted publication", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/paper-release-sealed.yml"),
    "utf8",
  );
  const authority = fs.readFileSync(
    path.join(root, ".github/workflows/.publication-authority.yml"),
    "utf8",
  );
  assert.match(workflow, /publication-candidate:/);
  assert.match(
    workflow,
    /uses: \.\/\.github\/workflows\/publication-artifact\.yml/,
  );
  assert.match(workflow, /prepare-paper-package: true/);
  assert.match(workflow, /publication-authority:/);
  assert.match(
    workflow,
    /buildchain-ref: \$\{\{ needs\.publication-candidate\.outputs\.runtime-sha \}\}/,
  );
  assert.match(workflow, /auto-admission-kind: publication-artifact/);
  assert.match(
    workflow,
    /required-status-check: \$\{\{ inputs\.required-status-check \}\}/,
  );
  assert.match(
    authority,
    /--required-status-check "\$\{\{ inputs\.required-status-check \}\}"/,
  );
  assert.match(
    workflow,
    /publish:\n    name: Publish admitted paper candidate/,
  );
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /Setup trusted-publishing Node\.js/);
  assert.match(workflow, /uses: actions\/setup-node@v6\.4\.0/);
  assert.match(workflow, /node-version: "24"/);
  assert.match(workflow, /BUILDCHAIN_GENERATED_WRITE_APP_CLIENT_ID:/);
  assert.match(workflow, /BUILDCHAIN_GENERATED_WRITE_APP_PRIVATE_KEY:/);
  assert.match(workflow, /BUILDCHAIN_GENERATED_WRITE_TOKEN:/);
  assert.match(workflow, /BUILDCHAIN_PROMOTION_TOKEN:\n\s+description:/);
  assert.match(
    workflow,
    /actions\/create-github-app-token@1b10c78c7865c340bc4f6099eb2f838309f1e8c3 # v3\.1\.1/,
  );
  assert.match(workflow, /permission-checks: write/);
  assert.match(workflow, /permission-contents: write/);
  assert.match(workflow, /permission-pull-requests: write/);
  assert.match(
    workflow,
    /generated-ref-update-token: \$\{\{ steps\.generated-write-app-token\.outputs\.token \|\| secrets\.BUILDCHAIN_GENERATED_WRITE_TOKEN \|\| secrets\.BUILDCHAIN_PROMOTION_TOKEN \}\}/,
  );
  assert.doesNotMatch(workflow, /generated-ref-update-token:.*github\.token/);
  assert.match(workflow, /github\.token fallback is forbidden/);
  assert.match(workflow, /Verify candidate bytes against sealed capability/);
  assert.match(
    workflow,
    /capability\.artifactDigest !== bundle\.candidate\.candidateDigest/,
  );
  assert.match(
    workflow,
    /resolvePublicationCandidateFile\(bundle\.evidence\.files, candidatePath\)/,
  );
  assert.match(workflow, /createPublicationSealedBundle/);
  assert.match(workflow, /verifyPublicationSealedBundle/);
  assert.match(
    workflow,
    /publish-sealed-bundle-root: \$\{\{ steps\.candidate\.outputs\.sealed-bundle-root \}\}/,
  );
  assert.match(
    workflow,
    /publish-sealed-bundle-manifest: \$\{\{ steps\.candidate\.outputs\.sealed-bundle-manifest \}\}/,
  );
  assert.doesNotMatch(workflow, /entry\.path\.endsWith/);
  assert.match(
    workflow,
    /github-release-artifact-paths: \$\{\{ steps\.candidate\.outputs\.github-release-artifact-paths \}\}/,
  );
  assert.match(workflow, /publish-transaction-override: "true"/);
  const publish = workflow.slice(workflow.indexOf("  publish:"));
  assert.doesNotMatch(
    publish,
    /Build publication|verify-command|latexmk|docker run/,
  );
});
