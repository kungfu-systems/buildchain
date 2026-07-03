import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyInfraContract,
  applyInfraContractPropagation,
  createInfraContractArtifact,
  createInfraContractEvidenceBundle,
  createInfraContractPlan,
  createInfraContractPropagationPlan,
  validateInfraContractProject,
  verifyInfraContractEvidenceBundle,
} from "../scripts/infra-contract-core.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(sortJson(value), null, 2);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function rehashEvidenceBundle(bundle) {
  const { bundleHash, ...base } = bundle;
  return {
    ...base,
    bundleHash: sha256(stableJson(base)),
  };
}

function withFixture(name, fn) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-infra-contract-"));
  const fixture = path.join(workspace, "fixture");
  fs.cpSync(path.join(root, "fixtures", name), fixture, { recursive: true });
  try {
    return fn(fixture);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

test("infra-contract manual-observed fixture validates and publishes observed contract", () => {
  withFixture("infra-contract-shaped", (fixture) => {
    const summary = validateInfraContractProject(fixture);
    assert.equal(summary.project.type, "infra-contract");
    assert.equal(summary.infra.adapter, "manual-observed");
    assert.equal(summary.infra.adoptionMode, "manual-observed");
    assert.equal(summary.infra.applyMode, "disabled");
    assert.equal(summary.consumers.length, 2);

    const sourceSha = "a".repeat(40);
    const plan = createInfraContractPlan({
      cwd: fixture,
      sourceSha,
      plannedAt: "2026-07-03T00:00:00.000Z",
    });
    assert.equal(plan.contract, "kungfu-buildchain-infra-contract-plan");
    assert.equal(plan.mutationAllowed, false);
    assert.equal(plan.adapterCapabilities.apply, false);
    assert.equal(plan.stages.apply.status, "disabled");
    assert.match(plan.planHash, /^[0-9a-f]{64}$/);

    const artifact = createInfraContractArtifact({
      cwd: fixture,
      plan,
      observedAt: "2026-07-03T00:00:00.000Z",
    });
    assert.equal(artifact.contract, "kungfu-buildchain-infra-contract");
    assert.equal(artifact.validation.mutationFree, true);
    assert.equal(artifact.validation.desiredAndObservedSeparated, true);
    assert.equal(artifact.observed.files.length, 2);
    assert.equal(artifact.observed.files[0].outputs.bucketName, "kungfu-tech-staging");
    assert.match(artifact.artifactHash, /^[0-9a-f]{64}$/);

    const propagation = createInfraContractPropagationPlan({ cwd: fixture, artifact });
    assert.equal(propagation.contract, "kungfu-buildchain-infra-contract-propagation-plan");
    assert.equal(propagation.mutationAllowed, false);
    assert.deepEqual(
      propagation.pullRequests.map((entry) => [entry.repo, entry.path]),
      [
        ["kungfu-systems/site-kungfu-tech", "infra/outputs.json"],
        ["kungfu-systems/site-libkungfu-dev", "infra/outputs.json"],
      ],
    );
  });
});

test("infra-contract terraform-shaped fixture proves the core is not CloudFormation-specific", () => {
  withFixture("infra-contract-terraform-shaped", (fixture) => {
    const summary = validateInfraContractProject(fixture);
    assert.equal(summary.infra.adapter, "terraform");
    assert.equal(summary.infra.adoptionMode, "observe-only");

    const plan = createInfraContractPlan({
      cwd: fixture,
      sourceSha: "b".repeat(40),
    });
    assert.equal(plan.adapter, "terraform");
    assert.equal(plan.adapterCapabilities.plan, true);
    assert.equal(plan.adapterCapabilities.observe, true);
    assert.equal(plan.stages.apply.status, "disabled");
    assert.deepEqual(
      plan.adapterEvidence.map((entry) => [entry.stage, entry.commandSource, entry.executed, entry.status]),
      [
        ["validate", "builtin-plan", false, "planned"],
        ["plan", "builtin-plan", false, "planned"],
      ],
    );
    assert.match(plan.adapterEvidence[1].command, /terraform plan/);
    assert.deepEqual(plan.desiredFiles.map((entry) => entry.path), ["desired/main.tf.json"]);
  });
});

test("infra-contract static provider fixtures cover built-in adapter shapes", () => {
  for (const [fixtureName, adapter, desiredPath, outputKey, planCommandPattern, observeCommandPattern] of [
    [
      "infra-contract-cloudformation-shaped",
      "aws-cloudformation",
      "desired/site-stack.template.json",
      "bucketName",
      /aws cloudformation create-change-set/,
      /aws cloudformation describe-stacks/,
    ],
    [
      "infra-contract-opentofu-shaped",
      "opentofu",
      "desired/main.tf.json",
      "bucketName",
      /tofu plan/,
      /tofu output -json/,
    ],
    [
      "infra-contract-pulumi-shaped",
      "pulumi",
      "desired/pulumi-preview.json",
      "bucketName",
      /pulumi preview --json/,
      /pulumi stack output --json/,
    ],
    [
      "infra-contract-aws-cdk-shaped",
      "aws-cdk",
      "desired/cdk.out/manifest.json",
      "bucketName",
      /npx cdk diff/,
      /aws cloudformation describe-stacks/,
    ],
    [
      "infra-contract-aws-cli-shaped",
      "aws-cli",
      "desired/request.json",
      "bucketName",
      /aws <service> <plan-or-dry-run-operation>/,
      /aws <service> <describe-operation>/,
    ],
  ]) {
    withFixture(fixtureName, (fixture) => {
      const summary = validateInfraContractProject(fixture);
      assert.equal(summary.infra.adapter, adapter);
      assert.equal(summary.infra.adoptionMode, "observe-only");
      assert.equal(summary.infra.applyMode, "disabled");

      const plan = createInfraContractPlan({
        cwd: fixture,
        sourceSha: "2".repeat(40),
        plannedAt: "2026-07-03T00:00:00.000Z",
      });
      assert.equal(plan.adapter, adapter);
      assert.equal(plan.mutationAllowed, false);
      assert.equal(plan.adapterCapabilities.validate, true);
      assert.equal(plan.adapterCapabilities.plan, true);
      assert.equal(plan.adapterCapabilities.observe, true);
      assert.equal(plan.stages.apply.status, "disabled");
      assert.deepEqual(plan.adapterEvidence.map((entry) => entry.stage), ["validate", "plan"]);
      assert.equal(plan.adapterEvidence.every((entry) => entry.commandSource === "builtin-plan"), true);
      assert.equal(plan.adapterEvidence.every((entry) => entry.executed === false), true);
      assert.match(plan.adapterEvidence[1].command, planCommandPattern);
      assert.deepEqual(plan.desiredFiles.map((entry) => entry.path), [desiredPath]);

      const artifact = createInfraContractArtifact({
        cwd: fixture,
        plan,
        observedAt: "2026-07-03T00:00:00.000Z",
        executeAdapterCommands: true,
      });
      assert.equal(artifact.observed.source, "adapter-observe");
      assert.equal(artifact.observed.files[0].outputs[outputKey].startsWith("example-"), true);
      assert.deepEqual(artifact.observed.adapterEvidence.map((entry) => [entry.stage, entry.executed]), [["observe", false]]);
      assert.match(artifact.observed.adapterEvidence[0].command, observeCommandPattern);
      assert.equal(artifact.validation.mutationFree, true);

      const propagation = createInfraContractPropagationPlan({ cwd: fixture, artifact });
      assert.equal(propagation.mutationAllowed, false);
      assert.equal(propagation.pullRequests.length, 1);
    });
  }
});

test("infra-contract custom-command adapter records planned and executed evidence", () => {
  withFixture("infra-contract-shaped", (fixture) => {
    fs.writeFileSync(
      path.join(fixture, "buildchain.toml"),
      `
schema = 1

[project]
type = "infra-contract"
name = "infra-custom-command"

[infra]
adapter = "custom-command"
adoption_mode = "observe-only"
apply = "disabled"
desired = ["desired/site-kungfu-tech.json"]
contract = ["outputs/site-kungfu-tech.json"]

[infra.commands]
validate = "custom validate"
plan = "custom plan"
observe = "custom observe"

[[consumers]]
repo = "kungfu-systems/site-kungfu-tech"
path = "infra/outputs.json"
source = "outputs/site-kungfu-tech.json"
`,
    );

    const plannedOnly = createInfraContractPlan({
      cwd: fixture,
      sourceSha: "6".repeat(40),
      plannedAt: "2026-07-03T00:00:00.000Z",
    });
    assert.deepEqual(
      plannedOnly.adapterEvidence.map((entry) => [entry.stage, entry.executed, entry.status]),
      [
        ["validate", false, "planned"],
        ["plan", false, "planned"],
      ],
    );

    const calls = [];
    const runner = (command, options = {}) => {
      calls.push({ command, cwd: options.cwd });
      return {
        status: 0,
        stdout: JSON.stringify({ command, cwd: path.basename(options.cwd) }),
        stderr: "",
      };
    };
    const plan = createInfraContractPlan({
      cwd: fixture,
      sourceSha: "6".repeat(40),
      plannedAt: "2026-07-03T00:00:00.000Z",
      executeAdapterCommands: true,
      commandRunner: runner,
    });
    assert.deepEqual(plan.adapterEvidence.map((entry) => entry.status), ["passed", "passed"]);
    assert.equal(plan.adapterEvidence[0].output.command, "custom validate");

    const artifact = createInfraContractArtifact({
      cwd: fixture,
      plan,
      observedAt: "2026-07-03T00:00:00.000Z",
      executeAdapterCommands: true,
      commandRunner: runner,
    });
    assert.equal(artifact.observed.adapterEvidence[0].stage, "observe");
    assert.equal(artifact.observed.adapterEvidence[0].status, "passed");
    assert.deepEqual(calls.map((call) => call.command), ["custom validate", "custom plan", "custom observe"]);
  });
});

test("infra-contract custom-command adapter fails closed on command failure", () => {
  withFixture("infra-contract-shaped", (fixture) => {
    fs.writeFileSync(
      path.join(fixture, "buildchain.toml"),
      `
schema = 1

[project]
type = "infra-contract"
name = "infra-custom-command"

[infra]
adapter = "custom-command"
adoption_mode = "observe-only"
apply = "disabled"
desired = ["desired/site-kungfu-tech.json"]
contract = ["outputs/site-kungfu-tech.json"]

[infra.commands]
validate = "custom validate"

[[consumers]]
repo = "kungfu-systems/site-kungfu-tech"
path = "infra/outputs.json"
source = "outputs/site-kungfu-tech.json"
`,
    );
    assert.throws(
      () => createInfraContractPlan({
        cwd: fixture,
        sourceSha: "7".repeat(40),
        executeAdapterCommands: true,
        commandRunner: () => ({ status: 2, stdout: "", stderr: "adapter failed" }),
      }),
      /adapter validate command failed/,
    );
  });
});

test("infra-contract apply fails closed without an explicit apply contract", () => {
  withFixture("infra-contract-shaped", (fixture) => {
    assert.throws(
      () => applyInfraContract({ cwd: fixture, sourceSha: "c".repeat(40), approvalId: "APPROVED-1" }),
      /infra-contract apply is disabled by config/,
    );
  });
});

test("infra-contract managed apply requires approval before mutation", () => {
  withFixture("infra-contract-terraform-shaped", (fixture) => {
    fs.writeFileSync(
      path.join(fixture, "buildchain.toml"),
      fs.readFileSync(path.join(fixture, "buildchain.toml"), "utf8")
        .replace('adoption_mode = "observe-only"', 'adoption_mode = "managed-apply"')
        .replace('apply = "disabled"', 'apply = "manual-approval"'),
    );
    const plan = createInfraContractPlan({
      cwd: fixture,
      sourceSha: "d".repeat(40),
      plannedAt: "2026-07-03T00:00:00.000Z",
    });
    assert.throws(
      () => applyInfraContract({ cwd: fixture, sourceSha: "d".repeat(40), plan }),
      /requires an approval id before mutation/,
    );
    const planned = applyInfraContract({
      cwd: fixture,
      sourceSha: "d".repeat(40),
      approvalId: "APPROVED-2",
      dryRun: true,
      plan,
      now: "2026-07-03T00:05:00.000Z",
    });
    assert.equal(planned.status, "planned");
    assert.equal(planned.planHash, plan.planHash);
    assert.equal(planned.planAgeSeconds, 300);
    assert.equal(planned.mutationExecuted, false);
  });
});

test("infra-contract managed apply requires a saved fresh plan", () => {
  withFixture("infra-contract-terraform-shaped", (fixture) => {
    fs.writeFileSync(
      path.join(fixture, "buildchain.toml"),
      fs.readFileSync(path.join(fixture, "buildchain.toml"), "utf8")
        .replace('adoption_mode = "observe-only"', 'adoption_mode = "managed-apply"')
        .replace('apply = "disabled"', 'apply = "manual-approval"'),
    );
    assert.throws(
      () => applyInfraContract({
        cwd: fixture,
        sourceSha: "e".repeat(40),
        approvalId: "APPROVED-3",
        dryRun: true,
      }),
      /requires a saved infra-contract plan/,
    );

    const plan = createInfraContractPlan({
      cwd: fixture,
      sourceSha: "e".repeat(40),
      plannedAt: "2026-07-03T00:00:00.000Z",
    });
    assert.throws(
      () => applyInfraContract({
        cwd: fixture,
        sourceSha: "f".repeat(40),
        approvalId: "APPROVED-3",
        dryRun: true,
        plan,
        now: "2026-07-03T00:01:00.000Z",
      }),
      /sourceSha mismatch/,
    );
    assert.throws(
      () => applyInfraContract({
        cwd: fixture,
        sourceSha: "e".repeat(40),
        approvalId: "APPROVED-3",
        dryRun: true,
        plan,
        now: "2026-07-03T02:00:01.000Z",
        planMaxAgeMinutes: 60,
      }),
      /plan is stale/,
    );
  });
});

test("infra-contract managed apply rejects a plan after desired inputs drift", () => {
  withFixture("infra-contract-terraform-shaped", (fixture) => {
    fs.writeFileSync(
      path.join(fixture, "buildchain.toml"),
      fs.readFileSync(path.join(fixture, "buildchain.toml"), "utf8")
        .replace('adoption_mode = "observe-only"', 'adoption_mode = "managed-apply"')
        .replace('apply = "disabled"', 'apply = "manual-approval"'),
    );
    const plan = createInfraContractPlan({
      cwd: fixture,
      sourceSha: "1".repeat(40),
      plannedAt: "2026-07-03T00:00:00.000Z",
    });
    fs.writeFileSync(path.join(fixture, "desired/main.tf.json"), "{ \"resource\": {} }\n");
    assert.throws(
      () => applyInfraContract({
        cwd: fixture,
        sourceSha: "1".repeat(40),
        approvalId: "APPROVED-4",
        dryRun: true,
        plan,
        now: "2026-07-03T00:01:00.000Z",
      }),
      /plan no longer matches current desired, contract, or consumer inputs/,
    );
  });
});

test("infra-contract custom-command apply executes only after explicit gates", () => {
  withFixture("infra-contract-shaped", (fixture) => {
    fs.writeFileSync(
      path.join(fixture, "buildchain.toml"),
      `
schema = 1

[project]
type = "infra-contract"
name = "infra-custom-command"

[infra]
adapter = "custom-command"
adoption_mode = "managed-apply"
apply = "manual-approval"
desired = ["desired/site-kungfu-tech.json"]
contract = ["outputs/site-kungfu-tech.json"]

[infra.commands]
validate = "custom validate"
plan = "custom plan"
apply = "custom apply"

[[consumers]]
repo = "kungfu-systems/site-kungfu-tech"
path = "infra/outputs.json"
source = "outputs/site-kungfu-tech.json"
`,
    );
    const sourceSha = "9".repeat(40);
    const plan = createInfraContractPlan({
      cwd: fixture,
      sourceSha,
      plannedAt: "2026-07-03T00:00:00.000Z",
      executeAdapterCommands: true,
      commandRunner: (command) => ({ status: 0, stdout: JSON.stringify({ command }), stderr: "" }),
    });
    assert.equal(plan.adapterEvidence.every((entry) => entry.executed), true);

    const dryRun = applyInfraContract({
      cwd: fixture,
      sourceSha,
      approvalId: "APPROVED-APPLY-1",
      dryRun: true,
      plan,
      now: "2026-07-03T00:01:00.000Z",
    });
    assert.equal(dryRun.status, "planned");
    assert.equal(dryRun.inputHash, plan.inputHash);
    assert.equal(dryRun.adapterEvidence[0].stage, "apply");
    assert.equal(dryRun.adapterEvidence[0].executed, false);

    assert.throws(
      () => applyInfraContract({
        cwd: fixture,
        sourceSha,
        approvalId: "APPROVED-APPLY-1",
        dryRun: false,
        plan,
        now: "2026-07-03T00:01:00.000Z",
      }),
      /requires --execute-adapter-commands true/,
    );

    const calls = [];
    const result = applyInfraContract({
      cwd: fixture,
      sourceSha,
      approvalId: "APPROVED-APPLY-1",
      dryRun: false,
      plan,
      now: "2026-07-03T00:01:00.000Z",
      executeAdapterCommands: true,
      commandRunner: (command) => {
        calls.push(command);
        return { status: 0, stdout: JSON.stringify({ stage: "apply", command }), stderr: "" };
      },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.mutationAllowed, true);
    assert.equal(result.mutationExecuted, true);
    assert.deepEqual(calls, ["custom apply"]);
    assert.equal(result.adapterEvidence[0].status, "passed");
    assert.equal(result.adapterEvidence[0].output.stage, "apply");
  });
});

test("infra-contract provider adapters can execute configured command hooks behind gates", () => {
  withFixture("infra-contract-terraform-shaped", (fixture) => {
    fs.writeFileSync(
      path.join(fixture, "buildchain.toml"),
      `
schema = 1

[project]
type = "infra-contract"
name = "infra-terraform"

[infra]
adapter = "terraform"
adoption_mode = "managed-apply"
apply = "manual-approval"
desired = ["desired/main.tf.json"]
contract = ["outputs/terraform-output.json"]

[infra.commands]
validate = "terraform validate -no-color"
plan = "terraform plan -input=false -out=.buildchain/infra-contract/terraform.tfplan"
observe = "terraform output -json"
apply = "terraform apply -input=false .buildchain/infra-contract/terraform.tfplan"

[[consumers]]
repo = "kungfu-systems/site-kungfu-tech"
path = "infra/outputs.json"
source = "outputs/terraform-output.json"
`,
    );
    const calls = [];
    const runner = (command) => {
      calls.push(command);
      return { status: 0, stdout: JSON.stringify({ command }), stderr: "" };
    };
    const sourceSha = "0".repeat(40);
    const plan = createInfraContractPlan({
      cwd: fixture,
      sourceSha,
      plannedAt: "2026-07-03T00:00:00.000Z",
      executeAdapterCommands: true,
      commandRunner: runner,
    });
    assert.deepEqual(
      plan.adapterEvidence.map((entry) => [entry.stage, entry.commandSource, entry.executable, entry.executed, entry.status]),
      [
        ["validate", "configured", true, true, "passed"],
        ["plan", "configured", true, true, "passed"],
      ],
    );

    const artifact = createInfraContractArtifact({
      cwd: fixture,
      plan,
      observedAt: "2026-07-03T00:01:00.000Z",
      executeAdapterCommands: true,
      commandRunner: runner,
    });
    assert.equal(artifact.observed.adapterEvidence[0].commandSource, "configured");
    assert.equal(artifact.observed.adapterEvidence[0].executed, true);
    assert.equal(artifact.observed.adapterEvidence[0].status, "passed");

    const dryRun = applyInfraContract({
      cwd: fixture,
      sourceSha,
      approvalId: "APPROVED-PROVIDER-APPLY-1",
      dryRun: true,
      plan,
      now: "2026-07-03T00:02:00.000Z",
    });
    assert.equal(dryRun.status, "planned");
    assert.equal(dryRun.adapterEvidence[0].commandSource, "configured");
    assert.equal(dryRun.adapterEvidence[0].executed, false);

    assert.throws(
      () => applyInfraContract({
        cwd: fixture,
        sourceSha,
        approvalId: "APPROVED-PROVIDER-APPLY-1",
        dryRun: false,
        plan,
        now: "2026-07-03T00:02:00.000Z",
      }),
      /requires --execute-adapter-commands true/,
    );

    const result = applyInfraContract({
      cwd: fixture,
      sourceSha,
      approvalId: "APPROVED-PROVIDER-APPLY-1",
      dryRun: false,
      plan,
      now: "2026-07-03T00:02:00.000Z",
      executeAdapterCommands: true,
      commandRunner: runner,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.mutationAllowed, true);
    assert.equal(result.mutationExecuted, true);
    assert.equal(result.adapterEvidence[0].commandSource, "configured");
    assert.equal(result.adapterEvidence[0].output.command, "terraform apply -input=false .buildchain/infra-contract/terraform.tfplan");
    assert.deepEqual(calls, [
      "terraform validate -no-color",
      "terraform plan -input=false -out=.buildchain/infra-contract/terraform.tfplan",
      "terraform output -json",
      "terraform apply -input=false .buildchain/infra-contract/terraform.tfplan",
    ]);
  });
});

test("infra-contract non custom-command apply stays fail-closed before adapter execution", () => {
  withFixture("infra-contract-terraform-shaped", (fixture) => {
    fs.writeFileSync(
      path.join(fixture, "buildchain.toml"),
      fs.readFileSync(path.join(fixture, "buildchain.toml"), "utf8")
        .replace('adoption_mode = "observe-only"', 'adoption_mode = "managed-apply"')
        .replace('apply = "disabled"', 'apply = "manual-approval"'),
    );
    const sourceSha = "a".repeat(40);
    const plan = createInfraContractPlan({
      cwd: fixture,
      sourceSha,
      plannedAt: "2026-07-03T00:00:00.000Z",
    });
    const dryRun = applyInfraContract({
      cwd: fixture,
      sourceSha,
      approvalId: "APPROVED-APPLY-2",
      dryRun: true,
      plan,
      now: "2026-07-03T00:01:00.000Z",
    });
    assert.equal(dryRun.adapterEvidence[0].stage, "apply");
    assert.equal(dryRun.adapterEvidence[0].commandSource, "builtin-plan");
    assert.equal(dryRun.adapterEvidence[0].executed, false);
    assert.match(dryRun.adapterEvidence[0].command, /terraform apply/);
    assert.throws(
      () => applyInfraContract({
        cwd: fixture,
        sourceSha,
        approvalId: "APPROVED-APPLY-2",
        dryRun: false,
        plan,
        now: "2026-07-03T00:01:00.000Z",
        executeAdapterCommands: true,
      }),
      /apply execution requires infra.commands.apply for adapter: terraform/,
    );
  });
});

test("infra-contract propagation apply defaults to mutation-free PR operations", () => {
  withFixture("infra-contract-shaped", (fixture) => {
    const plan = createInfraContractPlan({
      cwd: fixture,
      sourceSha: "3".repeat(40),
      plannedAt: "2026-07-03T00:00:00.000Z",
    });
    const artifact = createInfraContractArtifact({
      cwd: fixture,
      plan,
      observedAt: "2026-07-03T00:00:00.000Z",
    });
    const propagationPlan = createInfraContractPropagationPlan({ cwd: fixture, artifact });
    const result = applyInfraContractPropagation({ cwd: fixture, artifact, propagationPlan });

    assert.equal(result.contract, "kungfu-buildchain-infra-contract-propagation-apply");
    assert.equal(result.status, "planned");
    assert.equal(result.dryRun, true);
    assert.equal(result.mutationAllowed, false);
    assert.equal(result.mutationExecuted, false);
    assert.equal(result.operations.length, 2);
    assert.equal(result.operations[0].repo, "kungfu-systems/site-kungfu-tech");
    assert.equal(result.operations[0].status, "planned");
    assert.match(result.operations[0].commands.at(-1).join(" "), /gh pr create/);
  });
});

test("infra-contract propagation apply opens consumer PRs only after explicit approval", () => {
  withFixture("infra-contract-shaped", (fixture) => {
    const plan = createInfraContractPlan({
      cwd: fixture,
      sourceSha: "4".repeat(40),
      plannedAt: "2026-07-03T00:00:00.000Z",
    });
    const artifact = createInfraContractArtifact({
      cwd: fixture,
      plan,
      observedAt: "2026-07-03T00:00:00.000Z",
    });
    const propagationPlan = createInfraContractPropagationPlan({ cwd: fixture, artifact });
    assert.throws(
      () => applyInfraContractPropagation({ cwd: fixture, artifact, propagationPlan, dryRun: false }),
      /requires an approval id/,
    );

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-consumer-"));
    const workspaces = {
      "kungfu-systems/site-kungfu-tech": workspace,
      "kungfu-systems/site-libkungfu-dev": workspace,
    };
    const commands = [];
    const runner = (command, args, options = {}) => {
      commands.push({ command, args, cwd: options.cwd || "" });
      if (command === "git" && args.includes("status")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && args.includes("diff")) {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (command === "gh") {
        return { status: 0, stdout: `https://github.com/${args[args.indexOf("--repo") + 1]}/pull/1\n`, stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    try {
      const result = applyInfraContractPropagation({
        cwd: fixture,
        artifact,
        propagationPlan,
        dryRun: false,
        approvalId: "APPROVED-PROPAGATION-1",
        consumerWorkspaces: workspaces,
        runner,
      });
      assert.equal(result.status, "completed");
      assert.equal(result.mutationAllowed, true);
      assert.equal(result.mutationExecuted, true);
      assert.equal(result.operations.every((operation) => operation.status === "opened"), true);
      assert.equal(fs.existsSync(path.join(workspace, "infra", "outputs.json")), true);
      assert.equal(commands.filter((command) => command.command === "gh").length, 2);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

test("infra-contract evidence bundle binds contract and propagation evidence", () => {
  withFixture("infra-contract-shaped", (fixture) => {
    const plan = createInfraContractPlan({
      cwd: fixture,
      sourceSha: "5".repeat(40),
      plannedAt: "2026-07-03T00:00:00.000Z",
    });
    const artifact = createInfraContractArtifact({
      cwd: fixture,
      plan,
      observedAt: "2026-07-03T00:00:00.000Z",
    });
    const propagationPlan = createInfraContractPropagationPlan({ cwd: fixture, artifact });
    const propagationResult = applyInfraContractPropagation({ cwd: fixture, artifact, propagationPlan });
    const bundle = createInfraContractEvidenceBundle({
      artifact,
      propagationResult,
      createdAt: "2026-07-03T00:01:00.000Z",
    });

    assert.equal(bundle.contract, "kungfu-buildchain-infra-contract-evidence-bundle");
    assert.equal(bundle.artifactHash, artifact.artifactHash);
    assert.equal(bundle.lifecycle.desired.files.length, 2);
    assert.equal(bundle.lifecycle.plan.hash, plan.planHash);
    assert.equal(bundle.lifecycle.approval.required, false);
    assert.equal(bundle.lifecycle.apply.required, false);
    assert.equal(bundle.lifecycle.apply.result, null);
    assert.equal(bundle.lifecycle.observe.files.length, 2);
    assert.equal(bundle.lifecycle.contract.artifact.artifactHash, artifact.artifactHash);
    assert.equal(bundle.lifecycle.propagate.result.artifactHash, artifact.artifactHash);
    assert.equal(bundle.validation.artifactHashVerified, true);
    assert.match(bundle.bundleHash, /^[0-9a-f]{64}$/);

    const verification = verifyInfraContractEvidenceBundle(bundle);
    assert.equal(verification.ok, true);
    assert.equal(verification.artifactHash, artifact.artifactHash);
    assert.equal(verification.lifecycle.propagate, true);
  });
});

test("infra-contract evidence bundle verifier fails closed on tampering", () => {
  withFixture("infra-contract-shaped", (fixture) => {
    const plan = createInfraContractPlan({
      cwd: fixture,
      sourceSha: "a".repeat(40),
      plannedAt: "2026-07-03T00:00:00.000Z",
    });
    const artifact = createInfraContractArtifact({
      cwd: fixture,
      plan,
      observedAt: "2026-07-03T00:00:00.000Z",
    });
    const propagationPlan = createInfraContractPropagationPlan({ cwd: fixture, artifact });
    const propagationResult = applyInfraContractPropagation({ cwd: fixture, artifact, propagationPlan });
    const bundle = createInfraContractEvidenceBundle({
      artifact,
      propagationResult,
      createdAt: "2026-07-03T00:01:00.000Z",
    });
    const tampered = {
      ...bundle,
      lifecycle: {
        ...bundle.lifecycle,
        plan: {
          ...bundle.lifecycle.plan,
          hash: "1".repeat(64),
        },
        contract: {
          ...bundle.lifecycle.contract,
          hash: "0".repeat(64),
        },
      },
    };
    const verification = verifyInfraContractEvidenceBundle(tampered);
    assert.equal(verification.ok, false);
    assert.equal(
      verification.issues.some((issue) => issue.code === "bundle.hash.mismatch"),
      true,
    );
    assert.equal(
      verification.issues.some((issue) => issue.code === "contract.hash.mismatch"),
      true,
    );
    assert.equal(
      verification.issues.some((issue) => issue.code === "plan.binding.mismatch"),
      true,
    );
  });
});

test("infra-contract evidence bundle verifier recomputes validation summary", () => {
  withFixture("infra-contract-shaped", (fixture) => {
    const plan = createInfraContractPlan({
      cwd: fixture,
      sourceSha: "b".repeat(40),
      plannedAt: "2026-07-03T00:00:00.000Z",
    });
    const artifact = createInfraContractArtifact({
      cwd: fixture,
      plan,
      observedAt: "2026-07-03T00:00:00.000Z",
    });
    const propagationPlan = createInfraContractPropagationPlan({ cwd: fixture, artifact });
    const propagationResult = applyInfraContractPropagation({ cwd: fixture, artifact, propagationPlan });
    const bundle = createInfraContractEvidenceBundle({
      artifact,
      propagationResult,
      createdAt: "2026-07-03T00:01:00.000Z",
    });
    const tampered = rehashEvidenceBundle({
      ...bundle,
      validation: {
        ...bundle.validation,
        applyResultBound: false,
        mutationExecuted: true,
      },
    });

    const verification = verifyInfraContractEvidenceBundle(tampered);
    assert.equal(verification.ok, false);
    assert.equal(
      verification.issues.some((issue) => issue.code === "bundle.hash.mismatch"),
      false,
    );
    assert.equal(
      verification.issues.some((issue) => issue.code === "validation.applyResultBound.mismatch"),
      true,
    );
    assert.equal(
      verification.issues.some((issue) => issue.code === "validation.mutationExecuted.mismatch"),
      true,
    );
  });
});

test("infra-contract evidence bundle fails closed on mismatched apply or propagation evidence", () => {
  withFixture("infra-contract-shaped", (fixture) => {
    fs.writeFileSync(
      path.join(fixture, "buildchain.toml"),
      `
schema = 1

[project]
type = "infra-contract"
name = "infra-custom-command"

[infra]
adapter = "custom-command"
adoption_mode = "managed-apply"
apply = "manual-approval"
desired = ["desired/site-kungfu-tech.json"]
contract = ["outputs/site-kungfu-tech.json"]

[infra.commands]
validate = "custom validate"
plan = "custom plan"
apply = "custom apply"

[[consumers]]
repo = "kungfu-systems/site-kungfu-tech"
path = "infra/outputs.json"
source = "outputs/site-kungfu-tech.json"
`,
    );
    const sourceSha = "8".repeat(40);
    const plan = createInfraContractPlan({
      cwd: fixture,
      sourceSha,
      plannedAt: "2026-07-03T00:00:00.000Z",
    });
    const artifact = createInfraContractArtifact({
      cwd: fixture,
      plan,
      approvalId: "APPROVED-BUNDLE-1",
      observedAt: "2026-07-03T00:01:00.000Z",
    });
    const applyResult = applyInfraContract({
      cwd: fixture,
      sourceSha,
      approvalId: "APPROVED-BUNDLE-1",
      dryRun: true,
      plan,
      now: "2026-07-03T00:02:00.000Z",
    });
    const propagationPlan = createInfraContractPropagationPlan({ cwd: fixture, artifact });
    const propagationResult = applyInfraContractPropagation({ cwd: fixture, artifact, propagationPlan });

    assert.throws(
      () => createInfraContractEvidenceBundle({
        artifact,
        applyResult: { ...applyResult, planHash: "0".repeat(64) },
        propagationResult,
      }),
      /apply result planHash does not match/,
    );
    assert.throws(
      () => createInfraContractEvidenceBundle({
        artifact,
        applyResult,
        propagationResult: { ...propagationResult, artifactHash: "1".repeat(64) },
      }),
      /propagation result artifactHash does not match/,
    );

    const bundle = createInfraContractEvidenceBundle({
      artifact,
      applyResult,
      propagationResult,
      createdAt: "2026-07-03T00:03:00.000Z",
    });
    assert.equal(bundle.lifecycle.apply.result.planHash, plan.planHash);
    assert.equal(bundle.lifecycle.propagate.result.status, "planned");
    assert.equal(bundle.validation.applyResultBound, true);
    assert.equal(bundle.validation.propagationResultBound, true);
  });
});
