#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseWorkflowDocument,
  parseYamlUses,
} from "../packages/core/workflow-yaml-contract.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ledgerPath = path.join(root, "architecture/v4-release-topology.json");
const releaseMarker =
  /(?:release-candidate-promote\.yml|promote-buildchain-ref|v4-release-candidate-promote|release-tail-runtime)/u;

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function jobBlock(source, jobId) {
  const escaped = jobId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (
    source.match(
      new RegExp(
        `^  ${escaped}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_.-]+:|(?![\\s\\S]))`,
        "mu",
      ),
    )?.[1] || ""
  );
}

function permission(block, name) {
  return (
    new RegExp(`^      ${name}:\\s*([^#\\n]+)`, "mu")
      .exec(block)?.[1]
      ?.trim() || null
  );
}

function workflowSnapshot(relative) {
  const source = read(relative);
  const document = parseWorkflowDocument(source);
  const jobs = document.jobs.map((job) => {
    const block = jobBlock(source, job.id);
    const uses = job.uses || null;
    return {
      id: job.id,
      kind: uses ? "reusable-call" : "runner",
      uses,
      permissions: {
        contents: permission(block, "contents"),
        idToken: permission(block, "id-token"),
      },
      carriers: {
        artifactDownload: /uses:\s+actions\/download-artifact@/u.test(block),
        artifactUpload: /uses:\s+actions\/upload-artifact@/u.test(block),
        jobOutput: /GITHUB_OUTPUT/u.test(block),
      },
      mutationSignals: [
        /contents:\s*write/u.test(block) && "contents-write",
        /id-token:\s*write/u.test(block) && "oidc-write",
        /(?:promote-buildchain-ref|v4-release-candidate-promote)/u.test(
          block,
        ) && "promotion-runtime",
        /(?:git push|npm publish|gh release (?:create|upload))/u.test(block) &&
          "direct-publication-command",
      ].filter(Boolean),
    };
  });
  return {
    path: relative,
    triggers: document.triggers,
    jobs,
    reusableEdges: parseYamlUses(source)
      .map(({ value }) => value)
      .filter((value) => /\.github\/workflows\//u.test(value))
      .sort(),
  };
}

export function discoverV4ReleaseTopology(
  workflowPaths,
  semanticWorkflowPaths = workflowPaths,
) {
  const workflows = workflowPaths.map(workflowSnapshot);
  const jobs = workflows.flatMap((workflow) => workflow.jobs);
  const mutationJobs = jobs.filter((job) => job.mutationSignals.length > 0);
  const semanticPaths = new Set(semanticWorkflowPaths);
  const semanticJobs = workflows
    .filter((workflow) => semanticPaths.has(workflow.path))
    .flatMap((workflow) => workflow.jobs);
  const semanticMutationJobs = semanticJobs.filter(
    (job) => job.kind === "runner" && job.mutationSignals.length > 0,
  );
  return {
    jobRecordFields: [
      "id",
      "kind",
      "uses",
      "contentsPermission",
      "oidcPermission",
      "carriers",
      "mutationSignals",
    ],
    workflows: workflows.map((workflow) => ({
      path: workflow.path,
      triggers: workflow.triggers,
      jobs: workflow.jobs.map((job) =>
        [
          job.id,
          job.kind,
          job.uses || "-",
          job.permissions.contents || "-",
          job.permissions.idToken || "-",
          Object.entries(job.carriers)
            .filter(([, present]) => present)
            .map(([name]) => name)
            .join(",") || "-",
          job.mutationSignals.join(",") || "-",
        ].join("|"),
      ),
      reusableEdges: workflow.reusableEdges,
    })),
    metrics: {
      workflowCount: workflows.length,
      jobCount: jobs.length,
      reusableEdgeCount: workflows.reduce(
        (count, workflow) => count + workflow.reusableEdges.length,
        0,
      ),
      mutationRelevantNodeCount: jobs.filter(
        (job) =>
          job.kind === "reusable-call" ||
          job.mutationSignals.length > 0 ||
          job.carriers.artifactDownload ||
          job.carriers.artifactUpload,
      ).length,
      contentsWriteJobCount: mutationJobs.filter((job) =>
        job.mutationSignals.includes("contents-write"),
      ).length,
      oidcWriteJobCount: mutationJobs.filter((job) =>
        job.mutationSignals.includes("oidc-write"),
      ).length,
    },
    semanticMetrics: {
      workflowCount: semanticPaths.size,
      mutationRelevantNodeCount: semanticJobs.filter(
        (job) =>
          job.kind === "reusable-call" ||
          job.mutationSignals.length > 0 ||
          job.carriers.artifactDownload ||
          job.carriers.artifactUpload,
      ).length,
      contentsWriteJobCount: semanticMutationJobs.filter((job) =>
        job.mutationSignals.includes("contents-write"),
      ).length,
      oidcWriteJobCount: semanticMutationJobs.filter((job) =>
        job.mutationSignals.includes("oidc-write"),
      ).length,
    },
  };
}

export function findUnknownV4ReleaseTopology(
  workflowPaths,
  allWorkflowPaths = fs
    .readdirSync(path.join(root, ".github/workflows"))
    .filter((name) => /\.ya?ml$/u.test(name))
    .map((name) => `.github/workflows/${name}`),
  readWorkflow = read,
) {
  const declared = new Set(workflowPaths);
  return allWorkflowPaths
    .filter((relative) => !declared.has(relative))
    .filter((relative) => releaseMarker.test(readWorkflow(relative)))
    .sort();
}

function assertClosedWorld(workflowPaths) {
  const unknown = findUnknownV4ReleaseTopology(workflowPaths);
  assert.deepEqual(
    unknown,
    [],
    `unknown v4 release topology workflows: ${unknown.join(", ")}`,
  );
}

export function checkV4ReleaseTopology() {
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(ledger.contract, "kungfu-buildchain-v4-release-topology/v1");
  assertClosedWorld(ledger.closedWorld.workflowPaths);
  const actual = discoverV4ReleaseTopology(
    ledger.closedWorld.workflowPaths,
    ledger.semanticScope.workflowPaths,
  );
  assert.deepEqual(actual, ledger.observedTopology);
  assert.equal(
    ledger.targetBudgets.maximumMutationRelevantNodeCount,
    Math.floor(ledger.baselineMetrics.semanticMutationRelevantNodeCount / 2),
  );
  if (ledger.enforcement === "converged") {
    assert.ok(
      actual.semanticMetrics.mutationRelevantNodeCount <=
        ledger.targetBudgets.maximumMutationRelevantNodeCount,
    );
    assert.equal(actual.semanticMetrics.contentsWriteJobCount, 1);
    assert.equal(actual.semanticMetrics.oidcWriteJobCount, 1);
    const publisher = actual.workflows.find(
      ({ path: workflowPath }) =>
        workflowPath === ".github/workflows/.release-candidate-promote.yml",
    );
    assert.deepEqual(
      publisher.jobs.map((job) => job.split("|", 1)[0]),
      ["apply", "qualify", "settle"],
    );
  }
  return actual;
}

if (process.argv.includes("--print")) {
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  process.stdout.write(
    `${JSON.stringify(
      discoverV4ReleaseTopology(
        ledger.closedWorld.workflowPaths,
        ledger.semanticScope.workflowPaths,
      ),
      null,
      2,
    )}\n`,
  );
} else {
  checkV4ReleaseTopology();
  process.stdout.write("v4 release topology: ok\n");
}
