#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, ".github/workflows/.build.yml");
const targetPath = path.join(root, ".github/workflows/build.yml");

function blockBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error(`unable to locate workflow block: ${start.trim()}`);
  return source.slice(startIndex + start.length, endIndex);
}

function inputNames(inputBlock) {
  return [...inputBlock.matchAll(/^      ([a-z0-9-]+):$/gm)].map((match) => match[1]);
}

function routerInputs(inputBlock) {
  const adjusted = inputBlock.replace(
    /(      buildchain-contract-lock-path:\n(?:        .*\n)*?        default:) "buildchain\.contract-lock\.json"/,
    '$1 ""',
  );
  return [
    "      buildchain-channel:",
    '        description: "Buildchain runtime channel: auto, alpha, or stable"',
    '        default: "auto"',
    "        type: string",
    "        required: false",
    "      buildchain-alpha-contract-lock-path:",
    '        description: "Consumer-owned contract lock selected for the alpha channel"',
    '        default: ".buildchain/alpha-contract-lock.json"',
    "        type: string",
    "        required: false",
    "      buildchain-stable-contract-lock-path:",
    '        description: "Consumer-owned contract lock selected for the stable channel"',
    '        default: ".buildchain/contract-lock.json"',
    "        type: string",
    "        required: false",
    adjusted.trimEnd(),
  ].join("\n");
}

function routerOutputs(outputBlock) {
  const forwarded = outputBlock
    .replace(/^        value: \$\{\{ jobs\.[^.]+\.outputs\.([^ }]+) \}\}$/gm, "        value: ${{ jobs.alpha.outputs.$1 || jobs.stable.outputs.$1 }}")
    .replaceAll("build-lifecycle", "build-channel-router")
    .replace("value: ${{ jobs.alpha.outputs.controller-plan-artifact || jobs.stable.outputs.controller-plan-artifact }}", "value: ${{ jobs.controller-plan.outputs.controller-plan-artifact }}")
    .replace("value: ${{ jobs.alpha.outputs.controller-plan-json || jobs.stable.outputs.controller-plan-json }}", "value: ${{ jobs.controller-plan.outputs.controller-plan-json }}")
    .replace("value: ${{ jobs.alpha.outputs.controller-plan-digest || jobs.stable.outputs.controller-plan-digest }}", "value: ${{ jobs.controller-plan.outputs.controller-plan-digest }}")
    .replace("value: ${{ jobs.alpha.outputs.controller-receipt-artifact || jobs.stable.outputs.controller-receipt-artifact }}", "value: ${{ jobs.controller-receipt.outputs.controller-receipt-artifact }}")
    .replace("value: ${{ jobs.alpha.outputs.controller-receipt-json || jobs.stable.outputs.controller-receipt-json }}", "value: ${{ jobs.controller-receipt.outputs.controller-receipt-json }}")
    .replace("value: ${{ jobs.alpha.outputs.controller-receipt-digest || jobs.stable.outputs.controller-receipt-digest }}", "value: ${{ jobs.controller-receipt.outputs.controller-receipt-digest }}")
    .replace("value: ${{ jobs.alpha.outputs.controller-receipt-status || jobs.stable.outputs.controller-receipt-status }}", "value: ${{ jobs.controller-receipt.outputs.controller-receipt-status }}")
    .replace(
      /(      credential-island-macos-artifact:\n(?:        .*\n)*?        value:) \$\{\{ jobs\.alpha\.outputs\.artifact-name \|\| jobs\.stable\.outputs\.artifact-name \}\}/,
      "$1 ${{ jobs.alpha.outputs.credential-island-macos-artifact || jobs.stable.outputs.credential-island-macos-artifact }}",
    )
    .replace(
      /(      credential-island-macos-manifest-artifact:\n(?:        .*\n)*?        value:) \$\{\{ jobs\.alpha\.outputs\.manifest-artifact-name \|\| jobs\.stable\.outputs\.manifest-artifact-name \}\}/,
      "$1 ${{ jobs.alpha.outputs.credential-island-macos-manifest-artifact || jobs.stable.outputs.credential-island-macos-manifest-artifact }}",
    );
  return [
    "      buildchain-channel:",
    '        description: "Resolved Buildchain channel: alpha or stable"',
    "        value: ${{ jobs.resolve-channel.outputs.channel }}",
    "      buildchain-channel-selection-source:",
    '        description: "Evidence source used to select the Buildchain channel"',
    "        value: ${{ jobs.resolve-channel.outputs.selection-source }}",
    "      buildchain-channel-reason:",
    '        description: "Human-readable Buildchain channel selection reason"',
    "        value: ${{ jobs.resolve-channel.outputs.reason }}",
    forwarded.trimEnd(),
  ].join("\n");
}

function forwardedInputs(names) {
  return names
    .map((name) => {
      if (name === "buildchain-ref") return `      buildchain-ref: \${{ needs.resolve-channel.outputs.buildchain-ref }}`;
      if (name === "buildchain-contract-lock-path") {
        return "      buildchain-contract-lock-path: ${{ needs.resolve-channel.outputs.contract-lock-path }}";
      }
      return `      ${name}: \${{ inputs.${name} }}`;
    })
    .join("\n");
}

function routerControllerPlanJob() {
  return `  controller-plan:
    name: Plan channel router controller evidence
    needs: resolve-channel
    runs-on: \${{ fromJSON(inputs.control-runner-json) }}
    outputs:
      controller-plan-artifact: \${{ steps.names.outputs.controller-plan-artifact }}
      controller-plan-json: \${{ steps.plan.outputs.controller-plan-json }}
      controller-plan-digest: \${{ steps.plan.outputs.controller-plan-digest }}
      runtime-sha: \${{ steps.identities.outputs.runtime-sha }}
    steps:
      - name: Checkout Buildchain controller workflow shell
        uses: actions/checkout@v7.0.0
        with:
          repository: \${{ needs.resolve-channel.outputs.router-repository }}
          ref: \${{ needs.resolve-channel.outputs.router-sha }}
          path: .buildchain/controller-runtime
          persist-credentials: false

      - name: Resolve controller workflow shell identity
        id: identities
        shell: bash
        run: |
          runtime_sha="$(git -C .buildchain/controller-runtime rev-parse HEAD)"
          contract_digest="$(node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(".buildchain/controller-runtime/dist/site/buildchain-contract.json","utf8")); process.stdout.write(value.contractDigest)')"
          {
            echo "runtime-sha=\${runtime_sha}"
            echo "contract-digest=\${contract_digest}"
          } >> "$GITHUB_OUTPUT"

      - name: Create channel router controller plan
        id: plan
        run: node .buildchain/controller-runtime/scripts/controller-evidence.mjs --mode plan
        env:
          BUILDCHAIN_CONTROLLER_ID: build-channel-router
          BUILDCHAIN_CONTROLLER_SOURCE_REPOSITORY: \${{ github.repository }}
          BUILDCHAIN_CONTROLLER_SOURCE_SHA: \${{ github.sha }}
          BUILDCHAIN_CONTROLLER_RUNTIME_REF: \${{ needs.resolve-channel.outputs.router-ref }}
          BUILDCHAIN_CONTROLLER_RUNTIME_SHA: \${{ steps.identities.outputs.runtime-sha }}
          BUILDCHAIN_CONTROLLER_CONTRACT_DIGEST: \${{ steps.identities.outputs.contract-digest }}
          BUILDCHAIN_CONTROLLER_REGISTRY: .buildchain/controller-runtime/dist/site/controller-registry.json
          BUILDCHAIN_CONTROLLER_INPUTS_JSON: \${{ toJSON(inputs) }}
          BUILDCHAIN_CONTROLLER_INPUT_BOUNDARY: workflow-call
          BUILDCHAIN_CONTROLLER_PLAN_PATH: .buildchain/controller/plan.json

      - name: Resolve channel router controller plan artifact
        id: names
        run: echo "controller-plan-artifact=buildchain-channel-controller-plan-\${SOURCE_SHA}" >> "$GITHUB_OUTPUT"
        env:
          SOURCE_SHA: \${{ github.sha }}

      - name: Upload channel router controller plan
        uses: actions/upload-artifact@v7.0.1
        with:
          name: \${{ steps.names.outputs.controller-plan-artifact }}
          path: .buildchain/controller/plan.json
          if-no-files-found: error`;
}

function routerControllerReceiptJob() {
  return `  controller-receipt:
    name: Finalize channel router controller evidence
    needs:
      - resolve-channel
      - controller-plan
      - alpha
      - stable
    if: \${{ always() && needs.controller-plan.result == 'success' }}
    runs-on: \${{ fromJSON(inputs.control-runner-json) }}
    outputs:
      controller-receipt-artifact: \${{ steps.names.outputs.controller-receipt-artifact }}
      controller-receipt-json: \${{ steps.receipt.outputs.controller-receipt-json }}
      controller-receipt-digest: \${{ steps.receipt.outputs.controller-receipt-digest }}
      controller-receipt-status: \${{ steps.receipt.outputs.controller-receipt-status }}
    steps:
      - name: Checkout Buildchain controller workflow shell
        uses: actions/checkout@v7.0.0
        with:
          repository: \${{ needs.resolve-channel.outputs.router-repository }}
          ref: \${{ needs.controller-plan.outputs.runtime-sha }}
          path: .buildchain/controller-runtime
          persist-credentials: false

      - name: Download channel router controller plan
        uses: actions/download-artifact@v7.0.0
        with:
          name: \${{ needs.controller-plan.outputs.controller-plan-artifact }}
          path: .buildchain/controller

      - name: Create channel router controller receipt
        id: receipt
        run: node .buildchain/controller-runtime/scripts/controller-evidence.mjs --mode receipt
        env:
          BUILDCHAIN_CONTROLLER_PLAN_PATH: .buildchain/controller/plan.json
          BUILDCHAIN_CONTROLLER_STAGES_JSON: >-
            [{"id":"resolve-channel","status":"\${{ needs.resolve-channel.result }}"},{"id":"alpha","status":"\${{ needs.alpha.result }}"},{"id":"stable","status":"\${{ needs.stable.result }}"},{"id":"aggregate","status":"\${{ needs.resolve-channel.outputs.channel == 'alpha' && needs.alpha.result || needs.stable.result }}"}]
          BUILDCHAIN_CONTROLLER_EVIDENCE_JSON: \${{ (needs.alpha.outputs.controller-receipt-digest != '' || needs.stable.outputs.controller-receipt-digest != '') && format('[{{"kind":"nested-controller-receipt","digest":"{0}"}}]', needs.alpha.outputs.controller-receipt-digest || needs.stable.outputs.controller-receipt-digest) || '[]' }}
          BUILDCHAIN_CONTROLLER_REASON_CODE: \${{ ((needs.resolve-channel.outputs.channel == 'alpha' && needs.alpha.result == 'success') || (needs.resolve-channel.outputs.channel == 'stable' && needs.stable.result == 'success')) && '' || 'nested-build-incomplete' }}
          BUILDCHAIN_CONTROLLER_REASON_SUMMARY: Nested build controller did not complete successfully
          BUILDCHAIN_CONTROLLER_RECEIPT_ARTIFACT: buildchain-channel-controller-receipt-\${{ github.sha }}
          BUILDCHAIN_CONTROLLER_RECEIPT_PATH: .buildchain/controller/receipt.json

      - name: Resolve channel router controller receipt artifact
        id: names
        run: echo "controller-receipt-artifact=buildchain-channel-controller-receipt-\${SOURCE_SHA}" >> "$GITHUB_OUTPUT"
        env:
          SOURCE_SHA: \${{ github.sha }}

      - name: Upload channel router controller receipt
        if: \${{ always() && steps.receipt.outcome == 'success' }}
        uses: actions/upload-artifact@v7.0.1
        with:
          name: \${{ steps.names.outputs.controller-receipt-artifact }}
          path: .buildchain/controller/receipt.json
          if-no-files-found: error

      - name: Enforce qualifying channel router controller receipt
        if: \${{ steps.receipt.outputs.controller-receipt-qualifying != 'true' }}
        run: |
          echo "::error::channel router controller receipt is not qualifying: \${{ steps.receipt.outputs.controller-receipt-status }}"
          exit 1`;
}

function routerAggregateJob() {
  return `  summarize:
    name: Summarize build contract
    needs:
      - resolve-channel
      - alpha
      - stable
      - controller-receipt
    if: \${{ always() }}
    runs-on: \${{ fromJSON(inputs.control-runner-json) }}
    steps:
      - name: Enforce public channel router aggregate
        shell: bash
        env:
          CHANNEL: \${{ needs.resolve-channel.outputs.channel }}
          ALPHA_RESULT: \${{ needs.alpha.result }}
          STABLE_RESULT: \${{ needs.stable.result }}
          CONTROLLER_RECEIPT_RESULT: \${{ needs.controller-receipt.result }}
        run: |
          set -euo pipefail
          selected_result="\${STABLE_RESULT}"
          if [[ "\${CHANNEL}" = "alpha" ]]; then selected_result="\${ALPHA_RESULT}"; fi
          if [[ "\${selected_result}" != "success" || "\${CONTROLLER_RECEIPT_RESULT}" != "success" ]]; then
            echo "::error::Buildchain channel router did not qualify: channel=\${CHANNEL} selected=\${selected_result} controller-receipt=\${CONTROLLER_RECEIPT_RESULT}"
            exit 1
          fi
          echo "Buildchain channel router aggregate passed."`;
}

function generateChannelBuildWorkflowBase(source) {
  const inputs = blockBetween(source, "    inputs:\n", "    secrets:\n");
  const secrets = blockBetween(source, "    secrets:\n", "    outputs:\n");
  const outputs = blockBetween(source, "    outputs:\n", "\npermissions:\n");
  const names = inputNames(inputs);
  if (!names.includes("buildchain-ref") || !names.includes("publish-channel")) {
    throw new Error("source build workflow is missing channel-router inputs");
  }
  return `# Generated by scripts/generate-channel-build-workflow.mjs. Do not edit directly.\nname: Buildchain Channel Build\n\non:\n  workflow_call:\n    inputs:\n${routerInputs(inputs)}\n    secrets:\n${secrets.trimEnd()}\n    outputs:\n${routerOutputs(outputs)}\n\npermissions:\n  contents: read\n  issues: write\n  id-token: write\n\njobs:\n  resolve-channel:\n    name: Resolve Buildchain channel\n    runs-on: ubuntu-24.04\n    outputs:\n      channel: \${{ steps.channel.outputs.channel }}\n      buildchain-ref: \${{ steps.channel.outputs.buildchain-ref }}\n      contract-lock-path: \${{ steps.lock.outputs.path }}\n      selection-source: \${{ steps.channel.outputs.selection-source }}\n      reason: \${{ steps.channel.outputs.reason }}\n    steps:\n      - name: Resolve router source\n        id: router\n        shell: bash\n        env:\n          BUILDCHAIN_ROUTER_WORKFLOW_REF: \${{ job.workflow_ref }}\n        run: |\n          set -euo pipefail\n          workflow_ref=\"\${BUILDCHAIN_ROUTER_WORKFLOW_REF}\"\n          repository=\"\${workflow_ref%%/.github/workflows/*}\"\n          ref=\"\${workflow_ref##*@}\"\n          ref=\"\${ref#refs/heads/}\"\n          ref=\"\${ref#refs/tags/}\"\n          if [[ -z \"\${repository}\" || \"\${repository}\" = \"\${workflow_ref}\" || -z \"\${ref}\" ]]; then\n            echo \"Unable to resolve Buildchain router source from job.workflow_ref=\${workflow_ref}\" >&2\n            exit 1\n          fi\n          {\n            echo \"repository=\${repository}\"\n            echo \"ref=\${ref}\"\n          } >> \"\${GITHUB_OUTPUT}\"\n\n      - name: Checkout Buildchain router\n        uses: actions/checkout@v7.0.0\n        with:\n          repository: \${{ steps.router.outputs.repository }}\n          ref: \${{ steps.router.outputs.ref }}\n          path: .buildchain/router\n          persist-credentials: false\n\n      - name: Resolve channel\n        id: channel\n        shell: bash\n        env:\n          BUILDCHAIN_CHANNEL: \${{ inputs.buildchain-channel }}\n          BUILDCHAIN_REQUESTED_REF: \${{ inputs.buildchain-ref }}\n          BUILDCHAIN_PUBLISH_CHANNEL: \${{ inputs.publish-channel }}\n          BUILDCHAIN_EVENT_NAME: \${{ github.event_name }}\n          BUILDCHAIN_GIT_REF: \${{ github.ref }}\n          BUILDCHAIN_RELEASE_PRERELEASE: \${{ github.event.release.prerelease }}\n          BUILDCHAIN_ROUTER_REF: \${{ steps.router.outputs.ref }}\n        run: |\n          node .buildchain/router/scripts/buildchain-channel-router.mjs \\\n            --cwd .buildchain/router \\\n            --channel \"\${BUILDCHAIN_CHANNEL}\" \\\n            --buildchain-ref \"\${BUILDCHAIN_REQUESTED_REF}\" \\\n            --publish-channel \"\${BUILDCHAIN_PUBLISH_CHANNEL}\" \\\n            --event-name \"\${BUILDCHAIN_EVENT_NAME}\" \\\n            --ref \"\${BUILDCHAIN_GIT_REF}\" \\\n            --release-prerelease \"\${BUILDCHAIN_RELEASE_PRERELEASE}\" \\\n            --router-ref \"\${BUILDCHAIN_ROUTER_REF}\"\n\n      - name: Select consumer contract lock\n        id: lock\n        shell: bash\n        env:\n          EXPLICIT_PATH: \${{ inputs.buildchain-contract-lock-path }}\n          ALPHA_PATH: \${{ inputs.buildchain-alpha-contract-lock-path }}\n          STABLE_PATH: \${{ inputs.buildchain-stable-contract-lock-path }}\n          CHANNEL: \${{ steps.channel.outputs.channel }}\n        run: |\n          set -euo pipefail\n          path=\"\${EXPLICIT_PATH}\"\n          if [[ -z \"\${path}\" ]]; then\n            if [[ \"\${CHANNEL}\" = \"alpha\" ]]; then\n              path=\"\${ALPHA_PATH}\"\n            else\n              path=\"\${STABLE_PATH}\"\n            fi\n          fi\n          echo \"path=\${path}\" >> \"\${GITHUB_OUTPUT}\"\n\n  build:\n    name: Build with resolved channel\n    needs: resolve-channel\n    uses: ./.github/workflows/.build.yml\n    permissions:\n      contents: read\n      issues: write\n      id-token: write\n    with:\n${forwardedInputs(names)}\n    secrets: inherit\n`;
}

function splitBuildJobsByChannel(workflow, names, major) {
  const marker = "\n  build:\n";
  const index = workflow.indexOf(marker);
  if (index < 0) throw new Error("generated workflow is missing the build job");
  const inputs = forwardedInputs(names);
  const jobs = `
  alpha:
    name: Build alpha channel
    needs:
      - resolve-channel
      - controller-plan
    if: \${{ needs.resolve-channel.outputs.channel == 'alpha' }}
    uses: kungfu-systems/buildchain/.github/workflows/.build.yml@v${major}-alpha
    permissions:
      actions: read
      contents: read
      issues: write
      id-token: write
    with:
${inputs}
    secrets: inherit

  stable:
    name: Build stable channel
    needs:
      - resolve-channel
      - controller-plan
    if: \${{ needs.resolve-channel.outputs.channel == 'stable' }}
    uses: kungfu-systems/buildchain/.github/workflows/.build.yml@v${major}
    permissions:
      actions: read
      contents: read
      issues: write
      id-token: write
    with:
${inputs}
    secrets: inherit
`;
  return `${workflow.slice(0, index)}${jobs}`;
}

function bindRouterCheckoutToWorkflowSha(workflow) {
  return workflow
    .replace(
      "          BUILDCHAIN_ROUTER_WORKFLOW_REF: ${{ job.workflow_ref }}\n",
      [
        "          BUILDCHAIN_ROUTER_WORKFLOW_REF: ${{ job.workflow_ref }}",
        "          BUILDCHAIN_ROUTER_WORKFLOW_REPOSITORY: ${{ job.workflow_repository }}",
        "          BUILDCHAIN_ROUTER_WORKFLOW_SHA: ${{ job.workflow_sha }}",
        "",
      ].join("\n"),
    )
    .replace(
      [
        '          repository="${workflow_ref%%/.github/workflows/*}"',
        '          ref="${workflow_ref##*@}"',
        '          ref="${ref#refs/heads/}"',
        '          ref="${ref#refs/tags/}"',
        '          if [[ -z "${repository}" || "${repository}" = "${workflow_ref}" || -z "${ref}" ]]; then',
        '            echo "Unable to resolve Buildchain router source from job.workflow_ref=${workflow_ref}" >&2',
        "            exit 1",
        "          fi",
      ].join("\n"),
      [
        '          repository="${BUILDCHAIN_ROUTER_WORKFLOW_REPOSITORY}"',
        '          ref="${workflow_ref##*@}"',
        '          ref="${ref#refs/heads/}"',
        '          ref="${ref#refs/tags/}"',
        '          parsed_repository="${workflow_ref%%/.github/workflows/*}"',
        '          if [[ -z "${repository}" || "${repository}" != "${parsed_repository}" || -z "${ref}" ]]; then',
        '            echo "::error::Unable to resolve Buildchain router source from job.workflow_ref=${workflow_ref}"',
        "            exit 1",
        "          fi",
        '          if [[ ! "${BUILDCHAIN_ROUTER_WORKFLOW_SHA}" =~ ^[0-9a-fA-F]{40}$ ]]; then',
        '            echo "::error::job.workflow_sha is not an exact commit SHA"',
        "            exit 1",
        "          fi",
      ].join("\n"),
    )
    .replace(
      '            echo "ref=${ref}"\n',
      '            echo "ref=${ref}"\n            echo "sha=${BUILDCHAIN_ROUTER_WORKFLOW_SHA,,}"\n',
    )
    .replace(
      "          ref: ${{ steps.router.outputs.ref }}\n          path: .buildchain/router",
      "          ref: ${{ steps.router.outputs.sha }}\n          path: .buildchain/router",
    );
}

export function generateChannelBuildWorkflow(source) {
  const inputBlock = blockBetween(source, "    inputs:\n", "    secrets:\n");
  const names = inputNames(inputBlock);
  const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "";
  const major = Number(String(packageVersion).split(".")[0]);
  if (!Number.isInteger(major) || major < 1) throw new Error("package.json version must declare a positive major");
  const generated = bindRouterCheckoutToWorkflowSha(
    splitBuildJobsByChannel(generateChannelBuildWorkflowBase(source), names, major),
  )
    .replaceAll("runs-on: ubuntu-24.04", "runs-on: ${{ fromJSON(inputs.control-runner-json) }}")
    .replace(
      "\npermissions:\n  contents: read\n",
      "\npermissions:\n  actions: read\n  contents: read\n",
    )
    .replace(
      "      contract-lock-path: ${{ steps.lock.outputs.path }}\n",
      [
        "      contract-lock-path: ${{ steps.lock.outputs.path }}",
        "      router-repository: ${{ steps.router.outputs.repository }}",
        "      router-ref: ${{ steps.router.outputs.ref }}",
        "      router-sha: ${{ steps.router.outputs.sha }}",
        "",
      ].join("\n"),
    )
    .replace("\n  alpha:\n", `\n${routerControllerPlanJob()}\n\n  alpha:\n`);
  return `${generated.trimEnd()}\n\n${routerControllerReceiptJob()}\n\n${routerAggregateJob()}\n`;
}

function main() {
  const source = fs.readFileSync(sourcePath, "utf8");
  const generated = generateChannelBuildWorkflow(source);
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
    if (current !== generated) {
      console.error(".github/workflows/build.yml is stale; run node scripts/generate-channel-build-workflow.mjs");
      process.exitCode = 1;
    }
    return;
  }
  fs.writeFileSync(targetPath, generated);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
