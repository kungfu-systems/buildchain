import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createGateAggregate,
  createGateExecutionMatrix,
  sha256,
} from "../scripts/gate-profile-core.mjs";
import {
  prepareGateExecutionFiles,
  windowsBatchInvocation,
} from "../scripts/shifu-gate-profile.mjs";

const SOURCE_SHA = "1".repeat(40);
const DIGESTS = Object.freeze({
  registry: `sha256:${"2".repeat(64)}`,
  catalogAction: `sha256:${"3".repeat(64)}`,
  catalogDefinition: `sha256:${"4".repeat(64)}`,
  verifyAction: `sha256:${"5".repeat(64)}`,
  verifyDefinition: `sha256:${"6".repeat(64)}`,
});

test("Windows Gate batch commands resolve explicit relative paths before cmd.exe", () => {
  const explicit = windowsBatchInvocation(
    "./shifu.cmd",
    ["gate", "run", "--profile", "dev-patrol"],
    { cwd: "C:\\actions runner\\source", comSpec: "cmd.exe" },
  );
  assert.equal(explicit.command, "cmd.exe");
  assert.deepEqual(explicit.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(
    explicit.args[3],
    /^"C:\\actions runner\\source\\shifu\.cmd" gate run --profile dev-patrol$/,
  );

  const fromPath = windowsBatchInvocation("shifu.cmd", ["gate", "list"], {
    cwd: "C:\\ignored",
  });
  assert.equal(fromPath.args[3], "shifu.cmd gate list");
});

test("Gate execution removes only managed receipt files before a new run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-gate-run-"));
  const managed = ["receipt.json", "validation.json", "execution.json"].map(
    (name) => path.join(root, name),
  );
  const preserved = path.join(root, "diagnostics.log");
  try {
    for (const file of [...managed, preserved]) fs.writeFileSync(file, "stale\n");
    prepareGateExecutionFiles(managed);
    assert.deepEqual(managed.map((file) => fs.existsSync(file)), [false, false, false]);
    assert.equal(fs.readFileSync(preserved, "utf8"), "stale\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function plan(platform, { qualifying = true, unsupported = [] } = {}) {
  return {
    $schema: "https://example.invalid/shifu/gate-plan-v1.schema.json",
    schema: "shifu.gate-plan/v1",
    registry: {
      ref: "gates.json",
      digest: DIGESTS.registry,
      projectId: "fixture-project",
    },
    profile: "candidate",
    platform,
    includeAdvisory: true,
    explicitGates: [],
    ok: qualifying,
    qualifying,
    groups: [
      {
        index: 0,
        gates: [
          {
            id: "catalog.contract",
            mode: "required",
            selectedBy: ["profile:required"],
            dependencies: [],
            runner: { capabilities: ["node"] },
            actionId: DIGESTS.catalogAction,
            definitionDigest: DIGESTS.catalogDefinition,
            cost: { class: "light", timeoutSeconds: 60 },
          },
        ],
      },
      {
        index: 1,
        gates: [
          {
            id: "native.verify",
            mode: "advisory",
            selectedBy: ["profile:advisory"],
            dependencies: ["catalog.contract"],
            runner: { capabilities: ["native-toolchain"] },
            actionId: DIGESTS.verifyAction,
            definitionDigest: DIGESTS.verifyDefinition,
            cost: { class: "heavy", timeoutSeconds: 600 },
          },
        ],
      },
    ],
    skipped: [
      { id: "disabled.probe", mode: "off", reason: "profile mode is off" },
    ],
    unsupported,
  };
}

const platforms = [
  {
    id: "linux",
    name: "Linux",
    platform: "linux",
    runner: '["ubuntu-24.04"]',
    capabilities: ["node", "native-toolchain"],
  },
  {
    id: "windows",
    name: "Windows",
    platform: "windows",
    runner: '["windows-2022"]',
    capabilities: ["native-toolchain", "node"],
  },
];

function matrix() {
  return createGateExecutionMatrix({
    profile: "candidate",
    includeAdvisory: true,
    platforms,
    plans: { linux: plan("linux"), windows: plan("windows") },
  });
}

function execution(
  entry,
  {
    requiredStatus = "pass",
    advisoryStatus = "advisory-fail",
    qualifying = true,
  } = {},
) {
  const receipt = {
    schema: "shifu.gate-receipt/v1",
    runId: `run-${entry.id}`,
    project: { id: "fixture-project" },
    source: { sha: SOURCE_SHA, dirty: false },
    registry: entry.registry,
    selection: {
      profile: entry.profile,
      includeAdvisory: true,
      explicitGates: [],
    },
    environment: {
      platform: entry.platform,
      runnerCapabilities: entry.capabilities,
    },
    plan: {
      digest: entry.planDigest,
      qualifying: true,
      expectedActionIds: [],
      attemptedActionIds: [],
    },
    status: qualifying
      ? advisoryStatus === "advisory-fail"
        ? "advisory-fail"
        : "pass"
      : "fail",
    ok: qualifying,
    qualifying,
    results: [
      {
        gateId: "catalog.contract",
        policyMode: "required",
        actionId: DIGESTS.catalogAction,
        definitionDigest: DIGESTS.catalogDefinition,
        status: requiredStatus,
        attempted: true,
      },
      {
        gateId: "native.verify",
        policyMode: "advisory",
        actionId: DIGESTS.verifyAction,
        definitionDigest: DIGESTS.verifyDefinition,
        status: advisoryStatus,
        attempted: true,
      },
    ],
    skipped: [],
    unsupported: [],
    integrity: { digest: sha256({ platform: entry.platform }) },
  };
  return {
    receipt,
    validation: {
      schema: "shifu.gate-receipt-validation/v1",
      valid: true,
      current: true,
      qualifying,
      issues: [],
    },
  };
}

test("same Shifu plans resolve to a deterministic generic runner matrix", () => {
  const first = matrix();
  const second = matrix();
  assert.deepEqual(second, first);
  assert.equal(first.entries.length, 2);
  assert.deepEqual(
    first.entries.map((entry) => entry.platform),
    ["linux", "windows"],
  );
  assert.deepEqual(
    first.entries[0].gates.map(({ id, mode }) => ({ id, mode })),
    [
      { id: "catalog.contract", mode: "required" },
      { id: "native.verify", mode: "advisory" },
    ],
  );
  assert.equal(JSON.stringify(first).includes("kungfu"), false);
});

test("required runner capability gaps fail closed while optional platforms are recorded", () => {
  const incapable = { ...platforms[1], capabilities: ["node"] };
  assert.throws(
    () =>
      createGateExecutionMatrix({
        profile: "candidate",
        platforms: [incapable],
        plans: { windows: plan("windows") },
      }),
    /required gate platform windows cannot run: runner capabilities missing: native-toolchain/,
  );
  const optional = createGateExecutionMatrix({
    profile: "candidate",
    platforms: [{ ...incapable, required: false }, platforms[0]],
    plans: { windows: plan("windows"), linux: plan("linux") },
  });
  assert.equal(optional.entries.length, 1);
  assert.deepEqual(optional.omitted[0].reasons, [
    "runner capabilities missing: native-toolchain",
  ]);
});

test("required unsupported plan selections fail before runner dispatch", () => {
  assert.throws(
    () =>
      createGateExecutionMatrix({
        profile: "candidate",
        platforms: [platforms[0]],
        plans: {
          linux: plan("linux", {
            qualifying: false,
            unsupported: [
              {
                id: "required.native",
                mode: "required",
                reason: "unsupported platform",
              },
            ],
          }),
        },
      }),
    /plan is not qualifying; required gates unsupported: required.native/,
  );
});

test("aggregate preserves advisory failures without weakening required qualification", () => {
  const resolved = matrix();
  const executions = Object.fromEntries(
    resolved.entries.map((entry) => [entry.id, execution(entry)]),
  );
  const aggregate = createGateAggregate({
    matrix: resolved,
    sourceSha: SOURCE_SHA,
    executions,
  });
  assert.equal(aggregate.qualifying, true);
  assert.equal(aggregate.status, "pass");
  assert.equal(
    aggregate.gates.filter((gate) => gate.status === "advisory-fail").length,
    2,
  );
});

test("aggregate fails closed for missing, stale, failed, or definition-drifted receipts", () => {
  const resolved = matrix();
  const linux = execution(resolved.entries[0], {
    requiredStatus: "fail",
    qualifying: false,
  });
  linux.validation.current = false;
  linux.receipt.results[0].definitionDigest = `sha256:${"9".repeat(64)}`;
  const aggregate = createGateAggregate({
    matrix: resolved,
    sourceSha: SOURCE_SHA,
    executions: { linux },
  });
  assert.equal(aggregate.qualifying, false);
  assert.match(aggregate.issues.join("\n"), /receipt is stale/);
  assert.match(aggregate.issues.join("\n"), /definition digest mismatch/);
  assert.match(aggregate.issues.join("\n"), /windows: receipt is missing/);
});
