#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = path.join(
  root,
  "architecture/v4-universal-workflow-bootstrap.json",
);
const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
const laneBudgetPath = path.join(
  root,
  "architecture/ci-lane-change-budget.json",
);
const universalInput = `      universal-request-json:
        description: "Versioned exact-candidate request envelope; empty preserves the compatibility path"
        default: ""
        required: false
        type: string
`;
const bootstrapJob = `  universal-bootstrap:
    name: Universal exact-candidate execution
    if: \${{ inputs.universal-request-json != '' }}
    uses: kungfu-systems/buildchain/.github/workflows/bootstrap.yml@v4
    with:
      request-json: \${{ inputs.universal-request-json }}

`;

function fail(message) {
  throw new Error(message);
}

function activeFacadePaths() {
  const retired = new Set(contract.retiredWorkflowSurfaces || []);
  return contract.inventoryWorkflows.filter(
    (relative) =>
      relative !== contract.bootstrap.publicWorkflow && !retired.has(relative),
  );
}

function sourceRevision() {
  const revision = contract.migration.facadeSourceRevision;
  if (!/^[0-9a-f]{40}$/u.test(revision || ""))
    fail("migration.facadeSourceRevision must be an exact commit");
  return revision;
}

function materializeSourceRevision() {
  const revision = sourceRevision();
  try {
    execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], {
      cwd: root,
      stdio: "ignore",
    });
    return;
  } catch {
    // GitHub's default shallow checkout retains only the candidate head. The
    // compatibility proof still needs the immutable pre-migration facade
    // sources, so hydrate that one exact public commit rather than history.
  }
  try {
    execFileSync(
      "git",
      ["fetch", "--no-tags", "--depth=1", "origin", revision],
      { cwd: root, stdio: "pipe" },
    );
    execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], {
      cwd: root,
      stdio: "ignore",
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    fail(
      `facade source revision ${revision} is unavailable and could not be hydrated from origin${detail ? `: ${detail}` : ""}`,
    );
  }
}

function frozenFacadeSource(relative) {
  return execFileSync("git", ["show", `${sourceRevision()}:${relative}`], {
    cwd: root,
    encoding: "utf8",
  });
}

function isChannelGeneratedFacade(relative) {
  return (contract.migration.channelGeneratedFacades || []).includes(relative);
}

function addUniversalInput(source, relative) {
  if (source.includes("      universal-request-json:\n")) return source;
  const workflowCall = source.match(/^(\s*)workflow_call:\s*$/mu);
  if (!workflowCall) fail(`${relative} has no workflow_call mapping`);
  const callIndent = workflowCall[1];
  const inputHeader = `${callIndent}  inputs:\n`;
  const callEnd = workflowCall.index + workflowCall[0].length;
  if (source.slice(callEnd + 1).startsWith(inputHeader)) {
    const insertion = callEnd + 1 + inputHeader.length;
    return `${source.slice(0, insertion)}${universalInput}${source.slice(insertion)}`;
  }
  return `${source.slice(0, callEnd + 1)}\n${inputHeader}${universalInput}${source.slice(callEnd + 1)}`;
}

function conditionExpression(source, relative, jobId) {
  const child = source.match(/^(\s+)[A-Za-z0-9_-]+:/mu);
  const indent = child?.[1] || "    ";
  const match = source.match(new RegExp(`^${indent}if:\\s*(.*)$`, "mu"));
  if (!match)
    return `${indent}if: \${{ inputs.universal-request-json == '' }}\n`;
  const suffix = match[1].trim();
  if (suffix === ">-" || suffix === "|") {
    const start = match.index + match[0].length + 1;
    const tail = source.slice(start);
    const endMatch = tail.match(/^    [A-Za-z0-9_-]+:/mu);
    const end = endMatch ? start + endMatch.index : source.length;
    const raw = source.slice(start, end).trim();
    const inner = raw
      .replace(/^\$\{\{\s*/u, "")
      .replace(/\s*\}\}$/u, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n          ");
    if (!inner) fail(`${relative}#${jobId} has an empty multiline if`);
    return {
      start: match.index,
      end,
      value: `${indent}if: >-\n${indent}  \${{\n${indent}    inputs.universal-request-json == '' &&\n${indent}    (\n${indent}      ${inner}\n${indent}    )\n${indent}  }}\n`,
    };
  }
  const inner = suffix.startsWith("${{")
    ? suffix.replace(/^\$\{\{\s*/u, "").replace(/\s*\}\}$/u, "")
    : suffix;
  return {
    start: match.index,
    end:
      match.index +
      match[0].length +
      (source[match.index + match[0].length] === "\n" ? 1 : 0),
    value: `${indent}if: \${{ inputs.universal-request-json == '' && (${inner}) }}\n`,
  };
}

function guardCompatibilityJobs(source, relative) {
  const jobs = source.match(/^jobs:\s*$/mu);
  if (!jobs) fail(`${relative} has no jobs mapping`);
  const bodyStart = jobs.index + jobs[0].length + 1;
  const body = source.slice(bodyStart);
  const headers = [...body.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gmu)];
  if (headers.length === 0) fail(`${relative} has no jobs`);
  let rewritten = body;
  for (let index = headers.length - 1; index >= 0; index -= 1) {
    const header = headers[index];
    if (header[1] === "universal-bootstrap") continue;
    const start = header.index + header[0].length + 1;
    const end = headers[index + 1]?.index ?? body.length;
    const job = body.slice(start, end);
    if (job.includes("inputs.universal-request-json == ''")) continue;
    const condition = conditionExpression(job, relative, header[1]);
    if (typeof condition === "string") {
      rewritten = `${rewritten.slice(0, start)}${condition}${rewritten.slice(start)}`;
    } else {
      rewritten = `${rewritten.slice(0, start + condition.start)}${condition.value}${rewritten.slice(start + condition.end)}`;
    }
  }
  const withGuards = `${source.slice(0, bodyStart)}${rewritten}`;
  return withGuards.includes("  universal-bootstrap:\n")
    ? withGuards
    : `${withGuards.slice(0, bodyStart)}${bootstrapJob}${withGuards.slice(bodyStart)}`;
}

export function migrateV4UniversalWorkflowFacade(source, relative) {
  return guardCompatibilityJobs(addUniversalInput(source, relative), relative);
}

function verify(source, relative) {
  for (const snippet of [
    "      universal-request-json:\n",
    "  universal-bootstrap:\n",
    "uses: kungfu-systems/buildchain/.github/workflows/bootstrap.yml@v4",
  ]) {
    if (!source.includes(snippet))
      fail(`${relative} is missing ${snippet.trim()}`);
  }
  const jobs = source.slice(source.search(/^jobs:\s*$/mu));
  const headers = [...jobs.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gmu)];
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    if (header[1] === "universal-bootstrap") continue;
    const end = headers[index + 1]?.index ?? jobs.length;
    const block = jobs.slice(header.index, end);
    if (!block.includes("inputs.universal-request-json == ''"))
      fail(`${relative}#${header[1]} can overlap universal execution`);
  }
  if (!isChannelGeneratedFacade(relative)) {
    const expected = migrateV4UniversalWorkflowFacade(
      frozenFacadeSource(relative),
      relative,
    );
    if (source !== expected)
      fail(
        `${relative} differs from the exact generated facade rooted at ${sourceRevision()}`,
      );
  }
}

function laneBudget({ laneId, authorityClass, triggerClass, minutes, metric }) {
  return {
    laneId,
    authorityClass,
    triggerClass,
    concurrencyPolicy: { mode: "none", cancelInProgress: false },
    expectedRunnerMinutes: minutes,
    cancellationBehavior: "finish-started",
    sloImpact: {
      mergeCritical: false,
      metric,
      expectedContributionSeconds: 0,
      rationale:
        "The opt-in universal path preserves the default compatibility lane and executes only an exact admitted runtime.",
    },
  };
}

function updateLaneBudgets() {
  const policy = JSON.parse(fs.readFileSync(laneBudgetPath, "utf8"));
  const mixed = new Set([
    ".github/workflows/release-governance-reconcile.yml",
    ".github/workflows/v4-adopter-delivery.yml",
  ]);
  const facadeLanes = activeFacadePaths().map(
    (relative) => `${relative}#universal-bootstrap`,
  );
  policy.declarationFamilies = [
    {
      ...laneBudget({
        laneId: "",
        authorityClass: "governed-delegation",
        triggerClass: "reusable",
        minutes: 60,
        metric: "opt-in exact-candidate execution latency",
      }),
      laneIds: facadeLanes.filter(
        (laneId) => !mixed.has(laneId.split("#", 1)[0]),
      ),
    },
    {
      ...laneBudget({
        laneId: "",
        authorityClass: "governed-delegation",
        triggerClass: "mixed",
        minutes: 60,
        metric: "mixed-trigger exact-candidate execution latency",
      }),
      laneIds: facadeLanes.filter((laneId) =>
        mixed.has(laneId.split("#", 1)[0]),
      ),
    },
  ].map(({ laneId: _laneId, ...family }) => family);
  const universalLaneIds = new Set([
    ".github/workflows/bootstrap.yml#admit",
    ".github/workflows/bootstrap.yml#execute",
    ".github/workflows/bootstrap.yml#settle",
    ".github/workflows/universal-bootstrap-dogfood.yml#public-bootstrap",
  ]);
  policy.declarations = policy.declarations.filter(
    ({ laneId }) => !universalLaneIds.has(laneId),
  );
  policy.declarations.push(
    laneBudget({
      laneId: ".github/workflows/bootstrap.yml#admit",
      authorityClass: "evidence",
      triggerClass: "reusable",
      minutes: 10,
      metric: "exact-candidate admission latency",
    }),
    laneBudget({
      laneId: ".github/workflows/bootstrap.yml#execute",
      authorityClass: "governed-delegation",
      triggerClass: "reusable",
      minutes: 60,
      metric: "exact-candidate execution latency",
    }),
    laneBudget({
      laneId: ".github/workflows/bootstrap.yml#settle",
      authorityClass: "evidence",
      triggerClass: "reusable",
      minutes: 10,
      metric: "universal terminal settlement latency",
    }),
    laneBudget({
      laneId:
        ".github/workflows/universal-bootstrap-dogfood.yml#public-bootstrap",
      authorityClass: "governed-delegation",
      triggerClass: "manual",
      minutes: 60,
      metric: "public Bootstrap dogfood latency",
    }),
  );
  fs.writeFileSync(laneBudgetPath, `${JSON.stringify(policy, null, 2)}\n`);
}

function main() {
  const check = process.argv.includes("--check");
  const fresh = process.argv.includes("--fresh");
  materializeSourceRevision();
  for (const relative of activeFacadePaths()) {
    const target = path.join(root, relative);
    const source = fresh
      ? frozenFacadeSource(relative)
      : fs.readFileSync(target, "utf8");
    if (check) verify(source, relative);
    else
      fs.writeFileSync(
        target,
        migrateV4UniversalWorkflowFacade(source, relative),
      );
  }
  if (!check) {
    contract.bootstrapGovernedWorkflows = [
      contract.bootstrap.publicWorkflow,
      ...activeFacadePaths(),
    ].sort();
    contract.migration.compatibilityFacades = "generated-dual-path";
    fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
    updateLaneBudgets();
    process.stdout.write(
      `${JSON.stringify({ migrated: activeFacadePaths().length })}\n`,
    );
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
