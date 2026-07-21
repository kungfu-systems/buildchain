#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, ".github/workflows/.release-candidate-promote.yml");
const targetPath = path.join(root, ".github/workflows/release-candidate-promote.yml");
const routingPath = path.join(root, ".buildchain/promotion-shell-routing.json");
const internalInputs = new Set([
  "promotion-router-ref",
  "promotion-router-sha",
  "promotion-shell-ref",
  "promotion-shell-sha",
  "promotion-runtime-ref",
  "promotion-runtime-sha",
  "promotion-contract-lock-path",
  "promotion-contract-lock-digest",
  "promotion-publication-channel",
  "promotion-target-ref",
  "promotion-override-used",
]);

function blockBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error(`unable to locate workflow block: ${start.trim()}`);
  return source.slice(startIndex + start.length, endIndex);
}

function entries(block, indent = 6) {
  const pattern = new RegExp(`^ {${indent}}([a-z0-9-]+):$`, "gm");
  const matches = [...block.matchAll(pattern)];
  return matches.map((match, index) => ({
    name: match[1],
    source: block.slice(match.index, matches[index + 1]?.index ?? block.length).trimEnd(),
  }));
}

function publicInputs(inputBlock) {
  const retained = entries(inputBlock)
    .filter((entry) => !internalInputs.has(entry.name))
    .map((entry) => entry.name === "buildchain-contract-lock-path"
      ? entry.source.replace('        default: ".buildchain/contract-lock.json"', '        default: ""')
      : entry.source);
  return [
    "      buildchain-channel:",
    '        description: "Promotion workflow-shell/runtime channel: auto, alpha, or stable"',
    '        default: "auto"',
    "        type: string",
    "        required: false",
    "      buildchain-alpha-contract-lock-path:",
    '        description: "Consumer-owned contract lock selected for alpha promotion"',
    '        default: ".buildchain/alpha-contract-lock.json"',
    "        type: string",
    "        required: false",
    "      buildchain-stable-contract-lock-path:",
    '        description: "Consumer-owned contract lock selected for stable promotion"',
    '        default: ".buildchain/contract-lock.json"',
    "        type: string",
    "        required: false",
    ...retained,
  ].join("\n");
}

function publicOutputs(outputBlock) {
  const forwarded = entries(outputBlock).map((entry) => entry.source.replace(
    /^        value:.*$/m,
    `        value: \${{ jobs.alpha.outputs.${entry.name} || jobs.stable.outputs.${entry.name} }}`,
  ));
  const routed = [
    ["buildchain-channel", "Selected promotion workflow-shell channel", "channel"],
    ["promotion-router-ref", "Router workflow ref", "router-ref"],
    ["promotion-router-sha", "Resolved router workflow SHA", "router-sha"],
    ["promotion-shell-ref", "Selected advanced promotion workflow-shell ref", "shell-ref"],
    ["promotion-shell-sha", "Resolved advanced promotion workflow-shell SHA", "shell-sha"],
    ["promotion-runtime-ref", "Selected Buildchain runtime ref", "runtime-ref"],
    ["promotion-runtime-sha", "Resolved Buildchain runtime SHA", "runtime-sha"],
    ["promotion-contract-lock-path", "Selected consumer contract-lock path", "contract-lock-path"],
    ["promotion-contract-lock-digest", "Selected consumer contract-lock sha256 digest", "contract-lock-digest"],
    ["promotion-publication-channel", "Derived publication channel", "publication-channel"],
    ["promotion-target-ref", "Derived promotion target ref", "target-ref"],
    ["promotion-override-used", "Whether a trusted runtime override was used", "override-used"],
  ].map(([name, description, output]) => [
    `      ${name}:`,
    `        description: "${description}"`,
    `        value: \${{ jobs.resolve-promotion.outputs.${output} }}`,
  ].join("\n"));
  return [...routed, ...forwarded].join("\n");
}

function forwardedInputs(inputNames, { includeInternal = true, unsupportedInputs = [] } = {}) {
  const unsupported = new Set(unsupportedInputs);
  return inputNames
    .filter((name) => includeInternal || !internalInputs.has(name))
    .filter((name) => !unsupported.has(name))
    .map((name) => {
      const routed = {
        "buildchain-ref": "runtime-sha",
        "buildchain-contract-lock-path": "contract-lock-path",
        channel: "publication-channel",
        "target-ref": "target-ref",
        "promotion-router-ref": "router-ref",
        "promotion-router-sha": "router-sha",
        "promotion-shell-ref": "shell-ref",
        "promotion-shell-sha": "shell-sha",
        "promotion-runtime-ref": "runtime-ref",
        "promotion-runtime-sha": "runtime-sha",
        "promotion-contract-lock-path": "contract-lock-path",
        "promotion-contract-lock-digest": "contract-lock-digest",
        "promotion-publication-channel": "publication-channel",
        "promotion-target-ref": "target-ref",
        "promotion-override-used": "override-used",
      }[name];
      if (name === "promotion-override-used") {
        return `      ${name}: \${{ needs.resolve-promotion.outputs.override-used == 'true' }}`;
      }
      return routed
        ? `      ${name}: \${{ needs.resolve-promotion.outputs.${routed} }}`
        : `      ${name}: \${{ inputs.${name} }}`;
    }).join("\n");
}

function validateWorkflowRoute(name, route, expectedLogicalRef) {
  if (!route || typeof route !== "object") throw new Error(`promotion shell routing missing ${name} route`);
  if (route.logicalRef !== expectedLogicalRef) {
    throw new Error(`promotion shell ${name} logicalRef must be ${expectedLogicalRef}`);
  }
  if (!/^\.github\/workflows\/[.a-z0-9-]+\.ya?ml$/.test(route.workflowPath || "")) {
    throw new Error(`promotion shell ${name} workflowPath must name a reusable workflow`);
  }
  if (!/^(?:v[0-9]+(?:-alpha)?|[0-9a-f]{40})$/.test(route.callRef || "")) {
    throw new Error(`promotion shell ${name} callRef must be an official channel ref or exact SHA`);
  }
  if (typeof route.forwardInternalInputs !== "boolean") {
    throw new Error(`promotion shell ${name} forwardInternalInputs must be boolean`);
  }
  const unsupportedInputs = route.unsupportedInputs ?? [];
  if (
    !Array.isArray(unsupportedInputs) ||
    unsupportedInputs.some((input) => !/^[a-z0-9-]+$/.test(input)) ||
    new Set(unsupportedInputs).size !== unsupportedInputs.length
  ) {
    throw new Error(`promotion shell ${name} unsupportedInputs must contain unique workflow input names`);
  }
  return { ...route, unsupportedInputs };
}

export function parsePromotionShellRouting(source, { major = 2 } = {}) {
  const parsed = JSON.parse(source);
  if (parsed.schemaVersion !== 1) throw new Error("promotion shell routing schemaVersion must be 1");
  if (parsed.major !== major) throw new Error(`promotion shell routing major must be ${major}`);
  return {
    alpha: validateWorkflowRoute("alpha", parsed.alpha, `v${major}-alpha`),
    stable: validateWorkflowRoute("stable", parsed.stable, `v${major}`),
  };
}

export function generateChannelPromotionWorkflow(source, { major = 2, shellRouting } = {}) {
  const routes = shellRouting || {
    alpha: {
      logicalRef: `v${major}-alpha`,
      callRef: `v${major}-alpha`,
      workflowPath: ".github/workflows/.release-candidate-promote.yml",
      forwardInternalInputs: true,
      unsupportedInputs: [],
    },
    stable: {
      logicalRef: `v${major}`,
      callRef: `v${major}`,
      workflowPath: ".github/workflows/.release-candidate-promote.yml",
      forwardInternalInputs: true,
      unsupportedInputs: [],
    },
  };
  const alphaRoute = validateWorkflowRoute("alpha", routes.alpha, `v${major}-alpha`);
  const stableRoute = validateWorkflowRoute("stable", routes.stable, `v${major}`);
  const inputs = blockBetween(source, "    inputs:\n", "    secrets:\n");
  const secrets = blockBetween(source, "    secrets:\n", "    outputs:\n");
  const outputs = blockBetween(source, "    outputs:\n", "\nconcurrency:\n");
  const inputNames = entries(inputs).map((entry) => entry.name);
  for (const required of ["buildchain-ref", "buildchain-contract-lock-path", "channel", "target-ref", ...internalInputs]) {
    if (!inputNames.includes(required)) throw new Error(`advanced promotion workflow missing input: ${required}`);
  }
  const alphaForwarded = forwardedInputs(inputNames, {
    includeInternal: alphaRoute.forwardInternalInputs,
    unsupportedInputs: alphaRoute.unsupportedInputs,
  });
  const stableForwarded = forwardedInputs(inputNames, {
    includeInternal: stableRoute.forwardInternalInputs,
    unsupportedInputs: stableRoute.unsupportedInputs,
  });
  return `# Generated by scripts/generate-channel-promotion-workflow.mjs. Do not edit directly.
name: Release Candidate Promote

on:
  workflow_call:
    inputs:
${publicInputs(inputs)}
    secrets:
${secrets.trimEnd()}
    outputs:
${publicOutputs(outputs)}

permissions:
  actions: read
  checks: write
  contents: write
  id-token: write
  issues: write

jobs:
  resolve-promotion:
    name: Resolve promotion workflow shell and runtime
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    outputs:
      channel: \${{ steps.route.outputs.channel }}
      publication-channel: \${{ steps.route.outputs.publication-channel }}
      target-ref: \${{ steps.route.outputs.target-ref }}
      router-ref: \${{ steps.router.outputs.ref }}
      router-sha: \${{ steps.router.outputs.sha }}
      shell-ref: \${{ steps.route.outputs.shell-ref }}
      shell-sha: \${{ steps.identities.outputs.shell-sha }}
      runtime-ref: \${{ steps.route.outputs.runtime-ref }}
      runtime-sha: \${{ steps.identities.outputs.runtime-sha }}
      contract-lock-path: \${{ steps.lock.outputs.path }}
      contract-lock-digest: \${{ steps.lock.outputs.digest }}
      override-used: \${{ steps.route.outputs.override-used }}
      selection-source: \${{ steps.route.outputs.selection-source }}
      reason: \${{ steps.route.outputs.reason }}
    steps:
      - name: Resolve promotion router source
        id: router
        shell: bash
        env:
          BUILDCHAIN_ROUTER_WORKFLOW_REF: \${{ job.workflow_ref }}
          BUILDCHAIN_ROUTER_WORKFLOW_REPOSITORY: \${{ job.workflow_repository }}
          BUILDCHAIN_ROUTER_WORKFLOW_SHA: \${{ job.workflow_sha }}
        run: |
          set -euo pipefail
          workflow_ref="\${BUILDCHAIN_ROUTER_WORKFLOW_REF}"
          repository="\${BUILDCHAIN_ROUTER_WORKFLOW_REPOSITORY}"
          ref="\${workflow_ref##*@}"
          ref="\${ref#refs/heads/}"
          ref="\${ref#refs/tags/}"
          parsed_repository="\${workflow_ref%%/.github/workflows/*}"
          if [[ -z "\${repository}" || "\${repository}" != "\${parsed_repository}" || -z "\${ref}" ]]; then
            echo "::error::Unable to resolve promotion router source from job.workflow_ref=\${workflow_ref}"
            exit 1
          fi
          if [[ ! "\${BUILDCHAIN_ROUTER_WORKFLOW_SHA}" =~ ^[0-9a-fA-F]{40}$ ]]; then
            echo "::error::job.workflow_sha is not an exact commit SHA"
            exit 1
          fi
          {
            echo "repository=\${repository}"
            echo "ref=\${ref}"
            echo "sha=\${BUILDCHAIN_ROUTER_WORKFLOW_SHA,,}"
          } >> "\${GITHUB_OUTPUT}"

      - name: Checkout promotion router
        uses: actions/checkout@v7.0.0
        with:
          repository: \${{ steps.router.outputs.repository }}
          ref: \${{ steps.router.outputs.sha }}
          path: .buildchain/router
          persist-credentials: false

      - name: Resolve promotion channel
        id: route
        shell: bash
        run: >-
          node .buildchain/router/scripts/promotion-channel-router.mjs
          --cwd .buildchain/router
          --channel "\${{ inputs.buildchain-channel }}"
          --buildchain-ref "\${{ inputs.buildchain-ref }}"
          --publication-channel "\${{ inputs.channel }}"
          --target-ref "\${{ inputs.target-ref || github.ref_name }}"
          --router-ref "\${{ steps.router.outputs.ref }}"

      - name: Authorize trusted runtime override
        if: \${{ steps.route.outputs.override-used == 'true' }}
        uses: actions/github-script@v8
        with:
          script: |
            if (context.eventName !== "workflow_dispatch") {
              throw new Error("promotion runtime override is only allowed for trusted workflow_dispatch runs");
            }
            const permission = await github.rest.repos.getCollaboratorPermissionLevel({
              owner: context.repo.owner,
              repo: context.repo.repo,
              username: context.actor,
            });
            const level = permission.data.user?.permissions || permission.data.permission || "none";
            if (!["write", "maintain", "admin"].includes(level)) {
              throw new Error(\`promotion runtime override requires write, maintain, or admin permission; actor has \${level}\`);
            }

      - name: Resolve immutable promotion identities
        id: identities
        shell: bash
        env:
          GITHUB_TOKEN: \${{ github.token }}
          CHANNEL: \${{ steps.route.outputs.channel }}
          SELECTED_SHELL_REF: \${{ steps.route.outputs.shell-ref }}
          ALPHA_SHELL_REF: ${alphaRoute.logicalRef}
          ALPHA_SHELL_CALL_REF: ${alphaRoute.callRef}
          STABLE_SHELL_REF: ${stableRoute.logicalRef}
          STABLE_SHELL_CALL_REF: ${stableRoute.callRef}
        run: |
          set -euo pipefail
          if [[ "\${CHANNEL}" = "alpha" ]]; then
            expected_ref="\${ALPHA_SHELL_REF}"
            call_ref="\${ALPHA_SHELL_CALL_REF}"
          else
            expected_ref="\${STABLE_SHELL_REF}"
            call_ref="\${STABLE_SHELL_CALL_REF}"
          fi
          if [[ "\${SELECTED_SHELL_REF}" != "\${expected_ref}" ]]; then
            echo "::error::Selected promotion shell ref \${SELECTED_SHELL_REF} does not match configured \${expected_ref}"
            exit 1
          fi
          node .buildchain/router/scripts/promotion-identity-resolver.mjs \\
            --repository "\${{ steps.router.outputs.repository }}" \\
            --router-ref "\${{ steps.router.outputs.ref }}" \\
            --router-sha "\${{ steps.router.outputs.sha }}" \\
            --shell-ref "\${SELECTED_SHELL_REF}" \\
            --shell-call-ref "\${call_ref}" \\
            --runtime-ref "\${{ steps.route.outputs.runtime-ref }}"

      - name: Checkout selected promotion workflow shell
        uses: actions/checkout@v7.0.0
        with:
          repository: \${{ steps.router.outputs.repository }}
          ref: \${{ steps.identities.outputs.shell-sha }}
          path: .buildchain/shell
          persist-credentials: false

      - name: Checkout selected Buildchain runtime
        uses: actions/checkout@v7.0.0
        with:
          repository: \${{ steps.router.outputs.repository }}
          ref: \${{ steps.identities.outputs.runtime-sha }}
          path: .buildchain/runtime
          persist-credentials: false

      - name: Checkout promotion source
        uses: actions/checkout@v7.0.0
        with:
          ref: \${{ inputs.target-sha || github.sha }}
          path: .buildchain/source
          persist-credentials: false

      - name: Select and verify consumer contract lock
        id: lock
        shell: bash
        env:
          EXPLICIT_PATH: \${{ inputs.buildchain-contract-lock-path }}
          ALPHA_PATH: \${{ inputs.buildchain-alpha-contract-lock-path }}
          STABLE_PATH: \${{ inputs.buildchain-stable-contract-lock-path }}
          CHANNEL: \${{ steps.route.outputs.channel }}
        run: |
          set -euo pipefail
          path="\${EXPLICIT_PATH}"
          if [[ -z "\${path}" ]]; then
            if [[ "\${CHANNEL}" = "alpha" ]]; then path="\${ALPHA_PATH}"; else path="\${STABLE_PATH}"; fi
          fi
          if [[ -z "\${path}" || ! -f ".buildchain/source/\${path}" ]]; then
            echo "::error::Selected promotion contract lock is missing: \${path:-<empty>}"
            exit 1
          fi
          digest="sha256:$(shasum -a 256 ".buildchain/source/\${path}" | awk '{print $1}')"
          echo "path=\${path}" >> "\${GITHUB_OUTPUT}"
          echo "digest=\${digest}" >> "\${GITHUB_OUTPUT}"

      - name: Verify immutable promotion checkouts
        shell: bash
        env:
          CHANNEL: \${{ steps.route.outputs.channel }}
          ALPHA_SHELL_WORKFLOW_PATH: ${alphaRoute.workflowPath}
          STABLE_SHELL_WORKFLOW_PATH: ${stableRoute.workflowPath}
          ROUTER_SHA: \${{ steps.router.outputs.sha }}
          SHELL_SHA: \${{ steps.identities.outputs.shell-sha }}
          RUNTIME_SHA: \${{ steps.identities.outputs.runtime-sha }}
        run: |
          set -euo pipefail
          if [[ "\${CHANNEL}" = "alpha" ]]; then
            workflow_path="\${ALPHA_SHELL_WORKFLOW_PATH}"
          else
            workflow_path="\${STABLE_SHELL_WORKFLOW_PATH}"
          fi
          test -f ".buildchain/shell/\${workflow_path}"
          [[ "$(git -C .buildchain/router rev-parse HEAD)" = "\${ROUTER_SHA}" ]] || { echo "::error::Promotion router checkout moved"; exit 1; }
          [[ "$(git -C .buildchain/shell rev-parse HEAD)" = "\${SHELL_SHA}" ]] || { echo "::error::Promotion shell checkout moved"; exit 1; }
          [[ "$(git -C .buildchain/runtime rev-parse HEAD)" = "\${RUNTIME_SHA}" ]] || { echo "::error::Promotion runtime checkout moved"; exit 1; }

  alpha:
    name: Promote with alpha workflow shell
    needs: resolve-promotion
    if: \${{ needs.resolve-promotion.outputs.channel == 'alpha' }}
    uses: kungfu-systems/buildchain/${alphaRoute.workflowPath}@${alphaRoute.callRef}
    permissions:
      actions: read
      checks: write
      contents: write
      id-token: write
      issues: write
    with:
${alphaForwarded}
    secrets: inherit

  stable:
    name: Promote with stable workflow shell
    needs: resolve-promotion
    if: \${{ needs.resolve-promotion.outputs.channel == 'stable' }}
    uses: kungfu-systems/buildchain/${stableRoute.workflowPath}@${stableRoute.callRef}
    permissions:
      actions: read
      checks: write
      contents: write
      id-token: write
      issues: write
    with:
${stableForwarded}
    secrets: inherit
`;
}

function main() {
  const source = fs.readFileSync(sourcePath, "utf8");
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const major = Number(String(version).match(/^(\d+)\./)?.[1]);
  if (!Number.isInteger(major)) throw new Error("package version must expose a numeric major");
  const shellRouting = parsePromotionShellRouting(fs.readFileSync(routingPath, "utf8"), { major });
  const generated = generateChannelPromotionWorkflow(source, { major, shellRouting });
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
    if (current !== generated) {
      console.error(".github/workflows/release-candidate-promote.yml is stale; run node scripts/generate-channel-promotion-workflow.mjs");
      process.exitCode = 1;
    }
    return;
  }
  fs.writeFileSync(targetPath, generated);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
