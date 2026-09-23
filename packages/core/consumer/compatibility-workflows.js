import { adaptHistoricalPromotionWorkflow } from "./compatibility-promotion-workflows.js";
import fs from "node:fs";
import path from "node:path";

export const CONSUMER_UPGRADE_PATH = "architecture/consumer-upgrade.json";

export function readConsumerUpgrade(root, files) {
  const source = files
    ? files[CONSUMER_UPGRADE_PATH]
    : fs.existsSync(path.join(root, CONSUMER_UPGRADE_PATH))
      ? fs.readFileSync(path.join(root, CONSUMER_UPGRADE_PATH), "utf8")
      : undefined;
  if (!source) return null;
  const contract = JSON.parse(source);
  if (
    contract.schema !== "buildchain.consumer-upgrade/v1" ||
    !/^[a-f0-9]{40}$/u.test(contract.source?.sha || "") ||
    !Array.isArray(contract.entries)
  )
    throw new Error("Invalid consumer upgrade contract");
  return contract;
}

export function compatibilityWorkflowTarget(root, relative, source) {
  const entry = readConsumerUpgrade(root)?.entries.find(
    (item) => item.path === relative,
  );
  if (!entry) return relative;
  const canonical = fs.readFileSync(path.join(root, entry.target), "utf8");
  if (source !== renderCompatibilityWorkflow(entry, canonical))
    throw new Error(
      `${relative}: generated consumer compatibility workflow drift`,
    );
  return entry.target;
}

// Keep the historical job names, outputs, permissions and publisher identity.
// A nested forwarding job would change required check contexts and OIDC identity.
// Business steps are always generated from the one maintained implementation.
export function renderCompatibilityWorkflow(entry, source) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^on:\s*$/u.test(line));
  let end = start + 1;
  while (end < lines.length && !/^[a-z][a-z-]*:/u.test(lines[end])) end++;
  if (start < 0 || !entry.interfaceSource?.startsWith("on:\n"))
    throw new Error(
      `Consumer upgrade entry lacks its retained interface: ${entry.path}`,
    );
  lines.splice(start, end - start, entry.interfaceSource.trimEnd());
  let rendered =
    "# Generated from the consumer upgrade contract; edit the canonical implementation.\n" +
    lines.join("\n");
  if (entry.source || entry.inheritCallerPermissions) {
    const body = rendered.split("\n");
    const permissionStart = body.findIndex((line) =>
      /^permissions:/u.test(line),
    );
    const insertion =
      permissionStart < 0
        ? body.findIndex((line) => /^jobs:/u.test(line))
        : permissionStart;
    let permissionEnd = insertion + (permissionStart < 0 ? 0 : 1);
    while (
      permissionStart >= 0 &&
      permissionEnd < body.length &&
      !/^[a-z][a-z-]*:/u.test(body[permissionEnd])
    )
      permissionEnd++;
    const declaration =
      entry.permissions && !entry.inheritCallerPermissions
        ? [
            "permissions:",
            ...Object.entries(entry.permissions).map(
              ([key, value]) => `  ${key}: ${value}`,
            ),
          ]
        : [];
    body.splice(insertion, permissionEnd - insertion, ...declaration);
    rendered = body.join("\n");
  }
  if (entry.adapter === "build-v4.0") {
    const input = "compatibility-inputs: ${{ inputs.compatibility-inputs }}";
    if (!rendered.includes(input))
      throw new Error(
        "Historical build transport is missing from the canonical facade",
      );
    rendered = rendered.replace(
      input,
      "compatibility-inputs: ${{ toJSON(inputs) }}",
    );
    rendered = rendered.replace(
      "uses: ./.github/workflows/.build.yml",
      "uses: ./.github/workflows/.build-historical.yml",
    );
    rendered += `  summarize:
    name: Summarize build contract
    needs: build
    if: \${{ always() }}
    runs-on: \${{ fromJSON(inputs.control-runner-json) }}
    permissions:
      contents: read
    steps:
      - uses: $/actions/runtime/environment/prepare
        with:
          selection: \${{ needs.build.outputs.runtime-selection }}
          token: \${{ github.token }}
      - uses: ./.buildchain/runtime/actions/build/gate/qualify-contract
        with:
          conclusion: \${{ needs.build.result }}
          result: \${{ needs.build.outputs.result }}
`;
  }
  if (entry.adapter === "entry-v4.0") {
    const input = "          runtime-ref: ${{ inputs.runtime-ref }}\n";
    if (!rendered.includes(input))
      throw new Error(
        "Historical runtime entry is missing from the canonical implementation",
      );
    rendered = rendered.replace(
      input,
      input + "          compatibility-inputs: ${{ toJSON(inputs) }}\n",
    );
  }
  if (entry.adapter === "build-backbone") {
    const start = rendered.indexOf("  attest:\n"),
      end = rendered.indexOf("  deliver:\n", start);
    if (start < 0 || end < 0)
      throw new Error("Historical attestation boundary is missing");
    const job = rendered
      .slice(start, end)
      .replace(/    permissions:\n(?:      [^\n]*\n)+/u, "");
    rendered = rendered.slice(0, start) + job + rendered.slice(end);
    const step =
      "      - uses: ./.buildchain/runtime/actions/build/lifecycle/plan\n";
    const variables = Object.entries(entry.inputVariables || {}).map(
      ([input, variable]) => {
        if (
          !/^[a-z][a-z0-9-]+$/u.test(input) ||
          !/^BUILDCHAIN_[A-Z0-9_]+$/u.test(variable)
        )
          throw new Error("Invalid historical build variable binding");
        return `          BUILDCHAIN_HISTORICAL_${input.replaceAll("-", "_").toUpperCase()}: \${{ vars.${variable} }}`;
      },
    );
    if (variables.length) {
      if (!rendered.includes(step))
        throw new Error("Historical build plan adapter is missing");
      rendered = rendered.replace(
        step,
        step + "        env:\n" + variables.join("\n") + "\n",
      );
    }
  }
  return adaptHistoricalPromotionWorkflow(entry, rendered);
}

export function compatibilityWorkflowEntries(root, files, canonicalEntries) {
  const contract = readConsumerUpgrade(root, files);
  if (!contract) return [];
  const known = new Set(canonicalEntries.map((entry) => entry.path));
  const paths = new Set();
  return contract.entries.map((entry) => {
    if (
      !/^\.github\/workflows\/[.a-z0-9-]+\.yml$/u.test(entry.path) ||
      known.has(entry.path) ||
      paths.has(entry.path) ||
      !known.has(entry.target) ||
      entry.path === entry.target ||
      (entry.adapter &&
        ![
          "build-v4.0",
          "entry-v4.0",
          "build-backbone",
          "promotion-v4.0",
          "promotion-backbone",
        ].includes(entry.adapter)) ||
      (entry.inheritCallerPermissions &&
        !["build-v4.0", "build-backbone", "promotion-v4.0"].includes(
          entry.adapter,
        )) ||
      !entry.interface ||
      Object.keys(entry.interface).some(
        (key) => !["workflow_call", "workflow_dispatch"].includes(key),
      )
    )
      throw new Error(`Invalid consumer upgrade entry: ${entry.path}`);
    paths.add(entry.path);
    const target = canonicalEntries.find((item) => item.path === entry.target);
    return {
      ...target,
      ...entry,
      id: entry.path,
      role: "component",
      compatibility: true,
    };
  });
}
