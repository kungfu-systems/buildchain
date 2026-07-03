import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyInfraContract,
  applyInfraContractPropagation,
  createInfraContractArtifact,
  createInfraContractPlan,
  createInfraContractPropagationPlan,
  validateInfraContractProject,
} from "../scripts/infra-contract-core.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

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
    assert.deepEqual(plan.desiredFiles.map((entry) => entry.path), ["desired/main.tf.json"]);
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
