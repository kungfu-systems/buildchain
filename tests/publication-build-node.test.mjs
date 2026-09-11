import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { provePublicationReproducibility } from "../packages/core/publication/candidate/reproducibility.js";
import { readQualifiedManifest } from "../packages/core/publication/candidate/manifest.js";
import { bindQualifiedPackage } from "../packages/core/publication/candidate/paper-package.js";
const sha = "a".repeat(40),
  env = {
    BUILDCHAIN_REPOSITORY: "kungfu-systems/buildchain",
    BUILDCHAIN_WORKFLOW_SHA: sha,
    BUILDCHAIN_WORKFLOW_REF:
      "kungfu-systems/buildchain/.github/workflows/public-build-publication.yml@v4-alpha",
    BUILDCHAIN_REQUESTED_REF: "",
  };
const context = {
  eventName: "push",
  repo: { owner: "acme", repo: "paper" },
  actor: "author",
};
async function workspace(fn) {
  const old = process.cwd(),
    root = fs.mkdtempSync(
      path.join(os.tmpdir(), "buildchain-publication-node-"),
    );
  process.chdir(root);
  try {
    return await fn(root);
  } finally {
    process.chdir(old);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test("publication build records failed evidence and denies an unqualified package result", async () =>
  workspace(() => {
    const seen = [];
    assert.throws(
      () =>
        provePublicationReproducibility(
          {
            cwd: process.cwd(), sourceSha: sha,
            preparePaperPackage: true, packageName: "@acme/paper",
          },
          (options) => {
            seen.push(options);
            return { status: "passed", qualifying: false };
          },
        ),
      /qualifying evidence/,
    );
    assert.equal(seen[0].allowUnpinnedToolchain, false);
    assert.equal(seen[0].sourceSha, sha);
    assert.equal(
      JSON.parse(
        fs.readFileSync(".buildchain/publication-reproducibility-result.json"),
      ).qualifying,
      false,
    );
    const result = provePublicationReproducibility(
      { cwd: process.cwd(), sourceSha: sha, preparePaperPackage: false },
      () => ({ status: "passed", qualifying: false }),
    );
    assert.equal(result.status, "passed");
  }));
test("qualified manifest rejects a passing but non-qualifying Paper build", async () =>
  workspace(async (root) => {
    fs.mkdirSync(".buildchain/publication", { recursive: true });
    fs.writeFileSync(
      ".buildchain/publication/reproducibility-receipt.json",
      JSON.stringify({ status: "passed", qualifying: false, builds: [] }),
    );
    await assert.rejects(
      readQualifiedManifest({
        cwd: root, preparePaperPackage: true,
      }),
      /not qualifying/,
    );
    assert.ok(!fs.existsSync(path.join(root, "output")));
  }));
test("qualified package binding rejects provider errors, duplicate packs and integrity substitution", async () =>
  workspace(async (root) => {
    const directory = ".buildchain/publication/npm-package";
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "@acme/paper", version: "4.1.0-alpha.0" }),
    );
    fs.writeFileSync(
      ".buildchain/publication/reproducibility-receipt.json",
      JSON.stringify({
        status: "passed",
        qualifying: true,
        builds: [{ npmPackage: { integrity: "sha512-exact" } }],
      }),
    );
    const settings = { cwd: root };
    await assert.rejects(
      bindQualifiedPackage(settings, () => ({ status: 17 })),
      (error) => error.status === 17,
    );
    await assert.rejects(
      bindQualifiedPackage(settings, () => ({
        status: 0,
        stdout: JSON.stringify([
          { integrity: "sha512-exact" },
          { integrity: "sha512-exact" },
        ]),
      })),
      /exactly one/,
    );
    await assert.rejects(
      bindQualifiedPackage(settings, () => ({
        status: 0,
        stdout: JSON.stringify([{ integrity: "sha512-changed" }]),
      })),
      /integrity changed/,
    );
    assert.ok(!fs.existsSync(path.join(root, "output")));
  }));
test("publication workflow preserves central runtime preparation before business execution and always collects failure receipts", () => {
  const w = YAML.parse(
    fs.readFileSync(".github/workflows/public-build-publication.yml", "utf8"),
  );
  const steps = w.jobs.publication.steps;
  assert.equal(steps.length, 5);
  assert.equal(steps[0].id, "source");
  assert.equal(steps[0].with.ref, "${{ github.sha }}");
  assert.equal(steps[1].uses, "$/actions/runtime/environment/prepare");
  assert.equal(steps[2].if, "${{ always() }}");
  assert.equal(steps[2].with["source-checkout-outcome"], "${{ steps.source.outcome }}");
  assert.equal(steps.at(-1).if, "${{ always() }}");
  const build = YAML.parse(
    fs.readFileSync("actions/publication/candidate/build/action.yml", "utf8"),
  );
  assert.ok(build.runs.steps.every(step => step.uses && !step.run && !step.shell));
  assert.equal(build.runs.steps.at(-1).uses, "./.buildchain/runtime/actions/publication/candidate/qualify");
  const collect = YAML.parse(
    fs.readFileSync("actions/publication/candidate/collect/action.yml", "utf8"),
  );
  assert.ok(collect.runs.steps[0].uses.endsWith("/workflow/admission/reject"));
  assert.match(
    collect.runs.steps.find((s) => s.id === "controller-receipt").if,
    /always/,
  );
});
