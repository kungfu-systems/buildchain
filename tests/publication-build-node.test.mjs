import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { resolvePublicationRuntime } from "../packages/core/publication/nodes/runtime.mjs";
import { provePublicationReproducibility } from "../packages/core/publication/nodes/candidate-build.mjs";
import { readQualifiedManifest } from "../packages/core/publication/nodes/qualified-manifest.mjs";
import { bindQualifiedPackage } from "../packages/core/publication/nodes/qualified-package.mjs";
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
test("publication runtime defaults to its definition and admits only current authorized overrides", async () => {
  const values = {},
    core = { setOutput: (key, value) => (values[key] = value) };
  await resolvePublicationRuntime({ env, context, core, github: {} });
  assert.equal(values["runtime-sha"], sha);
  assert.equal(values["runtime-class"], "alpha");
  assert.equal(values["runtime-override"], "false");
  await resolvePublicationRuntime({
    env: { ...env, BUILDCHAIN_REQUESTED_REF: sha },
    context,
    core,
    github: {},
  });
  assert.equal(values["runtime-trust-decision"], "workflow-definition");
  for (const ref of ["v3", "dev/v4/v4.1", "train/v4/v4.1/topic"])
    await assert.rejects(
      resolvePublicationRuntime({
        env: { ...env, BUILDCHAIN_REQUESTED_REF: ref },
        context,
        core,
        github: {},
      }),
      /current v4 train|trusted workflow_dispatch/,
    );
  await assert.rejects(
    resolvePublicationRuntime({
      env: { ...env, BUILDCHAIN_REPOSITORY: "other/repo" },
      context,
      core,
      github: {},
    }),
    /defining workflow repository/,
  );
  const github = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => ({
          data: { permission: "read" },
        }),
      },
    },
  };
  await assert.rejects(
    resolvePublicationRuntime({
      env: { ...env, BUILDCHAIN_REQUESTED_REF: "b".repeat(40) },
      context: { ...context, eventName: "workflow_dispatch" },
      core,
      github,
    }),
    /write permission/,
  );
});
test("publication build records failed evidence and denies an unqualified package result", async () =>
  workspace(() => {
    const seen = [];
    assert.throws(
      () =>
        provePublicationReproducibility(
          {
            GITHUB_SHA: sha,
            INPUT_PREPARE_PAPER_PACKAGE: "true",
            INPUT_PACKAGE_NAME: "@acme/paper",
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
      { GITHUB_SHA: sha, INPUT_PREPARE_PAPER_PACKAGE: "false" },
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
        INPUT_PREPARE_PAPER_PACKAGE: "true",
        GITHUB_OUTPUT: path.join(root, "output"),
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
    const settings = { GITHUB_OUTPUT: path.join(root, "output") };
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
    assert.ok(!fs.existsSync(settings.GITHUB_OUTPUT));
  }));
test("publication workflow preserves runtime admission before source checkout and always collects failure receipts", () => {
  const w = YAML.parse(
    fs.readFileSync(".github/workflows/public-build-publication.yml", "utf8"),
  );
  const steps = w.jobs.publication.steps;
  assert.equal(steps.length, 7);
  assert.equal(steps[1].id, "runtime");
  assert.equal(steps[2].id, "source");
  assert.equal(steps[2].with.ref, "${{ github.sha }}");
  assert.equal(steps[3].if, "${{ always() }}");
  assert.equal(
    steps[4].with["source-checkout-outcome"],
    "${{ steps.source.outcome }}",
  );
  assert.equal(steps.at(-1).if, "${{ always() }}");
  const build = YAML.parse(
    fs.readFileSync("actions/publication/build-candidate/action.yml", "utf8"),
  );
  const verify = build.runs.steps.find((s) => s.id === "verify");
  assert.equal(
    verify.env.BUILDCHAIN_VERIFY_COMMAND,
    "${{ fromJSON(inputs.request-json).verify-command }}",
  );
  assert.match(verify.run, /\$BUILDCHAIN_VERIFY_COMMAND/);
  const collect = YAML.parse(
    fs.readFileSync("actions/publication/collect-candidate/action.yml", "utf8"),
  );
  assert.equal(collect.runs.steps[0].run.trim(), "exit 1");
  assert.match(
    collect.runs.steps.find((s) => s.id === "controller-receipt").if,
    /always/,
  );
});
