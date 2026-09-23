import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { resolveBuildConfiguration } from "../packages/core/build/plan/configuration.js";
import { runtimeSelector } from "../packages/core/runtime/entry/selection.js";
import YAML from "yaml";
import { fileURLToPath } from "node:url";
import { renderCompatibilityWorkflow } from "../packages/core/consumer/compatibility-workflows.js";

test("unchanged schema-1 consumer executes install, build and verify with the current CLI", (t) => {
  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-upgrade-"));
  t.after(() => fs.rmSync(consumer, { recursive: true, force: true }));
  fs.cpSync(path.join(root, "fixtures/libnode-shaped"), consumer, {
    recursive: true,
  });
  const configuration = fs.readFileSync(
    path.join(consumer, "buildchain.toml"),
    "utf8",
  );
  const invoke = (...args) => {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "bin/buildchain.mjs"), ...args],
      { cwd: consumer, encoding: "utf8", timeout: 60000 },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result;
  };
  invoke(
    "validate",
    "--require-version-state",
    "--require-lifecycle-stages",
    "install,build,verify",
  );
  for (const stage of ["install", "build", "verify"])
    invoke("lifecycle", "run", stage, "--required");
  assert.match(
    fs.readFileSync(path.join(consumer, "dist/install.txt"), "utf8"),
    /install ok/u,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(consumer, "dist/libnode-shaped.txt")))
      .fixture,
    "libnode-shaped",
  );
  assert.equal(
    fs.readFileSync(path.join(consumer, "buildchain.toml"), "utf8"),
    configuration,
  );
  assert.equal(
    fs.existsSync(path.join(consumer, ".github/workflows/buildchain.yml")),
    false,
  );
});

test("historical zero-input build retains its source, runtime lock and lifecycle declaration", (t) => {
  const consumer = fs.mkdtempSync(
    path.join(os.tmpdir(), "consumer-upgrade-plan-"),
  );
  t.after(() => fs.rmSync(consumer, { recursive: true, force: true }));
  fs.cpSync(path.join(root, "fixtures/libnode-shaped"), consumer, {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(consumer, ".github/workflows/build.yml"),
    "on: [workflow_dispatch]\njobs:\n  build:\n    uses: kungfu-systems/buildchain/.github/workflows/build.yml@v4\n",
  );
  const { plan } = resolveBuildConfiguration({
    root: consumer,
    repository: "kungfu-systems/buildchain",
    workflowRef: "kungfu-systems/buildchain/.github/workflows/.build.yml@v4",
    workflowSha: "a".repeat(40),
    sourceSha: "b".repeat(40),
    sourceRef: "refs/heads/dev/v1/v1.0",
    callerWorkflowRef:
      "example/consumer/.github/workflows/build.yml@refs/heads/dev/v1/v1.0",
  });
  assert.equal(plan.identity.visible_workflow, ".github/workflows/build.yml");
  assert.equal(plan.source.sha, "b".repeat(40));
  assert.deepEqual(Object.keys(plan.lifecycle), ["install", "build", "verify"]);
  const lock = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-contract-lock",
    buildchain: {
      ref: "v4",
      resolvedSha: "c".repeat(40),
      contractDigest: `sha256:${"d".repeat(64)}`,
    },
  };
  assert.deepEqual(runtimeSelector({ lock, workflowSha: "a".repeat(40) }), {
    ref: "c".repeat(40),
    origin: "contract-lock",
  });
  assert.throws(
    () =>
      runtimeSelector({
        lock: { ...lock, schemaVersion: 9 },
        workflowSha: "a".repeat(40),
      }),
    /Contract lock/u,
  );
});

const root = fileURLToPath(new URL("../", import.meta.url));
const contract = JSON.parse(
  fs.readFileSync(path.join(root, "architecture/consumer-upgrade.json")),
);

for (const entry of contract.entries) {
  test(`published consumer contract remains callable: ${entry.path}`, () => {
    const file = path.join(root, entry.path);
    assert.ok(fs.existsSync(file), `Published entry removed: ${entry.path}`);
    const actual = YAML.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(
      actual.on,
      entry.interface,
      "historical inputs, defaults, outputs and dispatch contract",
    );
    assert.deepEqual(
      actual.permissions ?? null,
      entry.inheritCallerPermissions ? null : entry.permissions,
      "historical permission boundary",
    );
    const implementation = YAML.parse(
      renderCompatibilityWorkflow(
        entry,
        fs.readFileSync(path.join(root, entry.target), "utf8"),
      ),
    );
    assert.deepEqual(
      actual.jobs,
      implementation.jobs,
      "same job contexts and maintained execution, without an extra forwarding job",
    );
  });
}

test("retained interfaces accept all observed libnode, kfd and taolu workflow arguments", () => {
  const { calls } = JSON.parse(
    fs.readFileSync(
      "contracts/fixtures/consumer-upgrade/consumer-calls.json",
      "utf8",
    ),
  );
  assert.equal(calls.length, 11);
  for (const call of calls) {
    const entry = YAML.parse(fs.readFileSync(call.entry, "utf8")).on
      .workflow_call;
    for (const key of call.inputs)
      assert.ok(
        entry.inputs[key],
        `${call.repository}:${call.workflow}#${call.job}: missing ${key}`,
      );
    for (const key of call.secrets)
      assert.ok(
        entry.secrets[key],
        `${call.repository}:${call.workflow}#${call.job}: missing secret declaration ${key}`,
      );
  }
});

test("actual old caller permissions admit every retained reusable job", () => {
  const { calls } = JSON.parse(
    fs.readFileSync(
      "contracts/fixtures/consumer-upgrade/consumer-calls.json",
      "utf8",
    ),
  );
  const rank = { none: 0, read: 1, write: 2 };
  function narrow(declaration, available, location) {
    if (!declaration) return available;
    for (const [key, value] of Object.entries(declaration))
      assert.ok(
        rank[value] <= (rank[available[key]] || 0),
        `${location}: ${key}:${value} exceeds caller grant ${available[key] || "none"}`,
      );
    return declaration;
  }
  function visit(file, available, chain) {
    assert.ok(!chain.includes(file), `recursive workflow ${file}`);
    const doc = YAML.parse(fs.readFileSync(file, "utf8"));
    const envelope = narrow(doc.permissions, available, file);
    for (const [name, job] of Object.entries(doc.jobs)) {
      const permissions = job.permissions
        ? narrow(job.permissions, available, `${file}#${name}`)
        : envelope;
      if (job.uses?.startsWith("./.github/workflows/"))
        visit(job.uses.slice(2), permissions, [...chain, file]);
    }
  }
  for (const call of calls) {
    assert.ok(
      call.permissions && typeof call.permissions === "object",
      `fixture requires exact permissions: ${call.repository}:${call.workflow}#${call.job}`,
    );
    visit(call.entry, call.permissions, []);
  }
});
