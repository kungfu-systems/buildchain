import assert from "node:assert/strict";
import test from "node:test";
import { auditRuntimeSourceBoundaries } from "../scripts/runtime-source-boundaries.mjs";

for (const source of [
  "function enforce(runtimeRoot, workspace) { if (path.resolve(runtimeRoot) !== path.resolve(workspace)) throw Error(); }",
  "if (fs.realpathSync(installationRoot(import.meta.url)) !== fs.realpathSync(workspace)) throw Error();",
  "if (path.resolve(workspace) === path.resolve(installationRoot(import.meta.url))) run();",
  "const installed = installationRoot(import.meta.url); const normalized = path.resolve(installed); if (normalized != sourceRoot) throw Error();",
  "const runtime = env.BUILDCHAIN_RUNTIME_ROOT; const target = env.GITHUB_WORKSPACE; if (runtime == target) run();",
])
  test(`rejects runtime/source identity gate: ${source}`, () => {
    assert.equal(auditRuntimeSourceBoundaries(source, "business.js").length, 1);
  });
test("source integrity, path containment, and runtime provenance remain permitted", () => {
  const source =
    "if (sourceSha(workspace) !== env.GITHUB_SHA) throw Error(); const runtime = installationRoot(import.meta.url); const receipt = { runtime, source: workspace }; if (!file.startsWith(workspace)) throw Error();";
  assert.deepEqual(auditRuntimeSourceBoundaries(source, "business.js"), []);
});
