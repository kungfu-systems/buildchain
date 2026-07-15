import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("sealed paper release separates read-only build, authority, and admitted publication", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/paper-release-sealed.yml"), "utf8");
  const authority = fs.readFileSync(path.join(root, ".github/workflows/.publication-authority.yml"), "utf8");
  assert.match(workflow, /publication-candidate:/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/publication-artifact\.yml/);
  assert.match(workflow, /prepare-paper-package: true/);
  assert.match(workflow, /publication-authority:/);
  assert.match(workflow, /buildchain-ref: \$\{\{ needs\.publication-candidate\.outputs\.runtime-sha \}\}/);
  assert.match(workflow, /auto-admission-kind: publication-artifact/);
  assert.match(workflow, /required-status-check: \$\{\{ inputs\.required-status-check \}\}/);
  assert.match(authority, /--required-status-check "\$\{\{ inputs\.required-status-check \}\}"/);
  assert.match(workflow, /publish:\n    name: Publish admitted paper candidate/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /Verify candidate bytes against sealed capability/);
  assert.match(workflow, /capability\.artifactDigest !== bundle\.candidate\.candidateDigest/);
  assert.match(workflow, /github-release-artifact-paths: \$\{\{ steps\.candidate\.outputs\.github-release-artifact-paths \}\}/);
  const publish = workflow.slice(workflow.indexOf("  publish:"));
  assert.doesNotMatch(publish, /Build publication|verify-command|latexmk|docker run/);
});
