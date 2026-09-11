#!/usr/bin/env node

import assert from "node:assert/strict";
import { inspectWorkflowJob, readWorkflow } from "./workflow-action-graph.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import ts from "typescript";

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  parseWorkflowDocument,
  parseYamlUses,
} from "../packages/core/contracts/workflow-yaml-contract.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ledgerPath = path.join(root, "architecture/release-topology.json");

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

const LOCAL_MODULE_EXTENSIONS = ["", ".js", ".mjs", ".cjs"];
const PRIVILEGED_ENTRYPOINTS = [
  "packages/core/release/promote-candidate/action.js",
  "packages/core/publication/binary/action.js",
  "packages/core/release/next-development/actions.js",
  "packages/core/publication/oci/preview-actions.js",
  "packages/core/publication/settlement/actions.js",
];

export function localModuleSpecifiers(source) {
  const specifiers = [];
  const visit = (node) => {
    let value;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      value = node.moduleSpecifier;
    else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    )
      value = node.arguments[0];
    if (value && ts.isStringLiteral(value) && value.text.startsWith("."))
      specifiers.push(value.text);
    ts.forEachChild(node, visit);
  };
  visit(
    ts.createSourceFile(
      "module.mjs",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    ),
  );
  return [...new Set(specifiers)].sort();
}

function resolveLocalModule(importer, specifier) {
  const unresolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer), specifier),
  );
  assert.ok(
    !unresolved.startsWith("../") && !path.posix.isAbsolute(unresolved),
    `local module import escapes the repository: ${importer} -> ${specifier}`,
  );
  const candidates = [
    ...LOCAL_MODULE_EXTENSIONS.map((extension) => `${unresolved}${extension}`),
    ...LOCAL_MODULE_EXTENSIONS.slice(1).map((extension) =>
      path.posix.join(unresolved, `index${extension}`),
    ),
  ];
  const matches = candidates.filter((relative) => {
    const absolute = path.join(root, relative);
    return fs.existsSync(absolute) && fs.statSync(absolute).isFile();
  });
  assert.equal(
    matches.length,
    1,
    `local module import must resolve exactly once: ${importer} -> ${specifier}`,
  );
  return matches[0];
}

export function discoverStaticModuleClosure(entrypoints) {
  const pending = [...entrypoints];
  const visited = new Set();
  while (pending.length > 0) {
    const relative = pending.pop();
    if (visited.has(relative)) continue;
    assert.ok(
      fs.statSync(path.join(root, relative)).isFile(),
      `privileged entry is not a file: ${relative}`,
    );
    visited.add(relative);
    for (const specifier of localModuleSpecifiers(read(relative))) {
      const dependency = resolveLocalModule(relative, specifier);
      if (!visited.has(dependency)) pending.push(dependency);
    }
  }
  return [...visited].sort();
}

function rootedPathSet(paths) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify([...paths].sort()))
    .digest("hex")}`;
}

function fileSha256(relative) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(root, relative)))
    .digest("hex")}`;
}

function productionFiles(relative, extensions) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return [];
  const entries = fs.readdirSync(absolute, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const child = path.posix.join(relative, entry.name);
    if (
      entry.isDirectory() &&
      !["dist", "node_modules", ".git"].includes(entry.name)
    )
      return productionFiles(child, extensions);
    if (
      entry.isFile() &&
      extensions.some((extension) => entry.name.endsWith(extension))
    )
      return [child];
    return [];
  });
}

function matchingProductionFiles(roots, extensions, pattern) {
  return roots
    .flatMap((relative) => productionFiles(relative, extensions))
    .filter((relative) => relative !== "scripts/check-release-topology.mjs")
    .filter((relative) => pattern.test(read(relative)))
    .sort();
}

export function discoverReleaseAuthorityClosure() {
  const providerPlane = matchingProductionFiles(
    ["actions", "packages/core"],
    [".js", ".mjs", ".cjs"],
    /(?:release-tail-provider-(?:adapters|plane)|create(?:GitHubReleaseAssets|SignedStaticChannel|SiteReleaseActivation|ReleasedEvidence)Adapter)/u,
  );
  const runtimeSelectors = productionFiles("packages/core/runtime/entry", [".js"]).sort();
  const terminalProjections = matchingProductionFiles(
    [".github/workflows", "actions", "packages/core", "scripts"],
    [".yml", ".yaml", ".js", ".mjs", ".cjs"],
    /(?:createReleaseReceipt|release-receipt\.json|RELEASE_RECEIPT_CONTRACT)/u,
  );
  const privilegedModules = discoverStaticModuleClosure(PRIVILEGED_ENTRYPOINTS);
  const rustWasmArtifact = "packages/core/runtime/buildchain-domain.wasm";
  const rustWasmDistributions = [
    "actions/release/promotion/ref/dist/buildchain-domain.wasm",
    "actions/release/tail/settle/dist/buildchain-domain.wasm",
    "actions/release/promotion/candidate/dist/buildchain-domain.wasm",
  ];
  const excludedRefPromotionModules = productionFiles(
    "packages/core/release/promote-ref",
    [".js", ".mjs", ".cjs"],
  )
    .filter((relative) =>
      /(?:^|\/)(?:lib|promote-(?:alpha|release|major)-channel|durable-transaction-operations)\.js$/u.test(
        relative,
      ),
    )
    .sort();
  return {
    providerAdapters: [
      ...new Set([
        ...providerPlane,
        "packages/core/release/release-tail-provider-plane.js",
      ]),
    ].sort(),
    runtimeSelectors,
    runtimeEngines: ["packages/core/release/promote-candidate/action.js"],
    terminalProjections,
    privilegedExecutableClosure: {
      entrypoints: PRIVILEGED_ENTRYPOINTS,
      modules: privilegedModules,
      root: rootedPathSet(privilegedModules),
    },
    rustWasmAuthority: {
      loader: "packages/core/runtime/domain-wasm.js",
      metadata: "packages/core/runtime/domain-wasm-artifact.js",
      artifact: rustWasmArtifact,
      artifactRoot: fileSha256(rustWasmArtifact),
      distributedArtifacts: rustWasmDistributions,
      byteIdenticalDistributions: rustWasmDistributions.every(
        (relative) => fileSha256(relative) === fileSha256(rustWasmArtifact),
      ),
      fallbackWriterCount: 0,
    },
    excludedRefPromotionModules,
  };
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
  const workflow = readWorkflow(relative, root);
  const source = read(relative);
  const jobs = Object.keys(workflow.jobs)
    .sort()
    .map((id) => {
      const graph = inspectWorkflowJob(relative, id, root);
      const job = graph.job;
      const block = JSON.stringify({ job, steps: graph.steps });
      const permissions = job.permissions || workflow.permissions || {};
      const inheritedPublisher =
        typeof permissions !== "string" &&
        !Object.keys(permissions).length &&
        graph.steps.some((step) =>
          /actions\/release\/promotion\/candidate$/.test(step.uses || ""),
        );
      const contents =
        permissions.contents || (inheritedPublisher ? "inherited" : null);
      const idToken =
        permissions["id-token"] || (inheritedPublisher ? "inherited" : null);
      return {
        id,
        kind: job.uses ? "reusable-call" : "runner",
        uses: job.uses || null,
        permissions: { contents, idToken },
        carriers: {
          artifactDownload: graph.steps.some((step) =>
            step.uses?.startsWith("actions/download-artifact@"),
          ),
          artifactUpload: graph.steps.some((step) =>
            step.uses?.startsWith("actions/upload-artifact@"),
          ),
          jobOutput: Object.keys(job.outputs || {}).length > 0,
        },
        mutationSignals: [
          ["write", "inherited"].includes(contents) && "contents-write",
          ["write", "inherited"].includes(idToken) && "oidc-write",
          /actions\/release\/promotion\/(?:candidate|ref)/u.test(block) &&
            "promotion-runtime",
          /(?:git push|npm publish|gh release (?:create|upload))/u.test(
            block,
          ) && "direct-publication-command",
        ].filter(Boolean),
      };
    });
  return {
    path: relative,
    triggers: Object.keys(workflow.on || {}).sort(),
    jobs,
    reusableEdges: Object.values(workflow.jobs)
      .flatMap((job) => (job.uses ? [job.uses] : []))
      .sort(),
  };
}

export function discoverReleaseTopology(
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
    workflows: workflows
      .filter((workflow) => semanticPaths.has(workflow.path))
      .map((workflow) => ({
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

export function findUnknownReleaseTopology(
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
    .filter((relative) => {
      const source = readWorkflow(relative);
      const usesReleaseAuthority = parseYamlUses(source).some(({ value }) =>
        /(?:release-candidate-promote|promote-buildchain-ref|release-tail|actions\/release\/promotion\/(?:candidate|ref)|\.github\/workflows\/(?:public-release-promote|\.release-promote))/u.test(
          value,
        ),
      );
      const hasReleaseLanguage =
        /(?:^|[-_ ])(?:release|publish|promotion|distribution|tag)(?:$|[-_ :])/imu.test(
          source,
        );
      const hasMutationAuthority =
        /(?:contents|id-token):\s*write/u.test(source) ||
        /(?:git push|npm publish|gh release (?:create|upload)|createRef|updateRef)/u.test(
          source,
        );
      return (
        usesReleaseAuthority || (hasReleaseLanguage && hasMutationAuthority)
      );
    })
    .sort();
}

function assertClosedWorld(workflowPaths) {
  const unknown = findUnknownReleaseTopology(workflowPaths);
  assert.deepEqual(
    unknown,
    [],
    `unknown v4 release topology workflows: ${unknown.join(", ")}`,
  );
}

function assertAuthorityClosure(ledger) {
  const closure = ledger.authorityClosure;
  assert.ok(
    closure && typeof closure === "object",
    "authority closure missing",
  );
  for (const className of [
    "providerAdapters",
    "runtimeSelectors",
    "runtimeEngines",
    "terminalProjections",
    "excludedRefPromotionModules",
  ]) {
    assert.ok(
      Array.isArray(closure[className]) && closure[className].length > 0,
      `authority closure class ${className} is empty`,
    );
    for (const relative of closure[className])
      assert.ok(
        fs.statSync(path.join(root, relative)).isFile(),
        `authority closure path is not a file: ${relative}`,
      );
  }
  const discovered = discoverReleaseAuthorityClosure();
  for (const className of Object.keys(discovered))
    assert.deepEqual(
      closure[className],
      discovered[className],
      `authority closure class drifted: ${className}`,
    );
  assert.deepEqual(
    closure.privilegedExecutableClosure,
    discovered.privilegedExecutableClosure,
    "privileged executable transitive closure drifted",
  );
  assert.match(
    closure.privilegedExecutableClosure.root,
    /^sha256:[0-9a-f]{64}$/u,
  );
  const reachableRefPromotionEngines =
    closure.excludedRefPromotionModules.filter((relative) =>
      closure.privilegedExecutableClosure.modules.includes(relative),
    );
  assert.deepEqual(
    reachableRefPromotionEngines,
    [],
    `separate ref-promotion engines remain reachable from APPLY: ${reachableRefPromotionEngines.join(", ")}`,
  );
  assert.deepEqual(closure.runtimeEngines, [
    "packages/core/release/promote-candidate/action.js",
  ]);
  assert.equal(
    closure.freshEntry,
    ".github/workflows/public-release-promote.yml",
  );
  assert.equal(
    closure.recoveryEntry,
    ".github/workflows/self-ops-promotion-recovery.yml",
  );
  const engineSurface = [
    ".github/workflows/.release-promote.yml",
    ...closure.privilegedExecutableClosure.modules,
  ]
    .map(read)
    .join("\n");
  for (const pattern of closure.forbiddenPublisherPatterns)
    assert.doesNotMatch(
      engineSurface,
      new RegExp(pattern, "u"),
      `legacy release engine remains reachable: ${pattern}`,
    );
  const canonicalWorkflow = read(".github/workflows/.release-promote.yml");
  const qualify = inspectWorkflowJob(
    ".github/workflows/.release-promote.yml",
    "qualify",
    root,
  );
  assert.ok(
    qualify.modules.has("packages/core/release/promotion/qualification.js"),
  );
  const apply = inspectWorkflowJob(
    ".github/workflows/.release-promote.yml",
    "apply",
    root,
  );
  assert.ok(
    apply.modules.has("packages/core/release/promote-candidate/action.js"),
  );
  assert.match(
    apply.modules.get(
      "packages/core/release/promote-candidate/release-documents.js",
    ),
    /release-invocation\.json[\s\S]*release-transaction\.json/,
  );
  assert.match(
    apply.modules.get(
      "packages/core/release/promote-candidate/provider-settlement.js",
    ),
    /release-receipt\.json/,
  );
  const settle = inspectWorkflowJob(
    ".github/workflows/.release-promote.yml",
    "settle",
    root,
  );
  assert.ok(settle.actions.has("actions/publication/settlement/verify"));
  assert.match(
    settle.modules.get("packages/core/publication/settlement/actions.js"),
    /verifyPublicationSettlement/,
  );
}

export function checkReleaseTopology() {
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(ledger.contract, "kungfu-buildchain-v4-release-topology/v1");
  assertClosedWorld(ledger.closedWorld.workflowPaths);
  assertAuthorityClosure(ledger);
  const preview = ledger.postPublicationScope;
  assert.deepEqual(preview.workflowPaths, [
    ".github/workflows/public-release-oci-compose-preview.yml",
  ]);
  const previewTopology = discoverReleaseTopology(
    preview.workflowPaths,
    preview.workflowPaths,
  );
  assert.equal(previewTopology.semanticMetrics.contentsWriteJobCount, 1);
  assert.equal(previewTopology.semanticMetrics.oidcWriteJobCount, 0);
  assert.deepEqual(preview.observedTopology, previewTopology);
  const actual = discoverReleaseTopology(
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
        workflowPath === ".github/workflows/.release-promote.yml",
    );
    assert.deepEqual(
      publisher.jobs.map((job) => job.split("|", 1)[0]),
      ["apply", "execution-runtime", "qualify", "settle"],
    );
  }
  return actual;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.includes("--print-closure")) {
    process.stdout.write(
      `${JSON.stringify(discoverReleaseAuthorityClosure(), null, 2)}\n`,
    );
  } else if (process.argv.includes("--print")) {
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    process.stdout.write(
      `${JSON.stringify(
        discoverReleaseTopology(
          ledger.closedWorld.workflowPaths,
          ledger.semanticScope.workflowPaths,
        ),
        null,
        2,
      )}\n`,
    );
  } else {
    checkReleaseTopology();
    process.stdout.write("v4 release topology: ok\n");
  }
}
