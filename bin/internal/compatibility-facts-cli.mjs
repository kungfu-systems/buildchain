import path from "node:path";

import {
  createBuildchainCompatibilityFactRegistry,
  verifyBuildchainCompatibilityFactRegistry,
} from "../../packages/core/buildchain-compatibility-fact.js";
import {
  createBuildchainCompatibilityPathQuery,
  createBuildchainCompatibilityProofRegistry,
  verifyBuildchainCompatibilityPath,
} from "../../packages/core/buildchain-compatibility-authority.js";
import { createBuildchainContractWorld } from "../../packages/core/buildchain-contract.js";
import {
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  writeJsonFile,
} from "./cli-options.mjs";

export function runCompatibilityFactsCli({ args, cwd, packageRoot }) {
  const [action = "project", ...factArgs] = args;
  const registryInput = readFlag(factArgs, "registry", "");
  const registry = registryInput
    ? readJsonInput(registryInput, {
        cwd,
        label: "compatibility Fact registry",
      })
    : createBuildchainCompatibilityFactRegistry();
  if (action === "project") {
    const world = createBuildchainContractWorld({ root: packageRoot });
    const projection = createBuildchainCompatibilityProofRegistry({
      proofs: registry.legacyProofs,
      surfaces: world.surfaces,
      majorLine: world.majorLine,
    });
    const result = {
      schema: "kungfu.buildchain.compatibility-fact-projection/v1",
      authority: "Fact-registry-only",
      grantsReleaseAuthority: false,
      registry,
      projections: projection.projections,
    };
    const output = readFlag(factArgs, "output", "");
    if (output) writeJsonFile(path.resolve(cwd, output), result);
    if (readBooleanFlag(factArgs, "json") || !output) printJson(result);
    else
      process.stdout.write(
        `buildchain facts compatibility project: wrote ${output}\n`,
      );
    return;
  }
  if (action === "verify") {
    const result = verifyBuildchainCompatibilityFactRegistry(registry);
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === "query") {
    const queryInput = readFlag(factArgs, "query", "");
    if (!queryInput) {
      throw new Error(
        "usage: buildchain facts compatibility query --query <json-or-path> [--registry <json-or-path>]",
      );
    }
    const query = readJsonInput(queryInput, {
      cwd,
      label: "compatibility Fact query",
    });
    const receipt = verifyBuildchainCompatibilityPath({ registry, query });
    printJson(receipt);
    if (receipt.record.status !== "accepted") process.exitCode = 1;
    return;
  }
  if (action === "query-template") {
    const factRoot = readFlag(factArgs, "fact-root", "");
    const fact = registry.facts.find((entry) => entry.factRoot === factRoot);
    if (!fact) {
      throw new Error(
        "buildchain facts compatibility query-template requires a current --fact-root",
      );
    }
    printJson(
      createBuildchainCompatibilityPathQuery({
        registry,
        queryId: readFlag(
          factArgs,
          "query-id",
          `buildchain:compatibility:${fact.factId}`,
        ),
        sourceRoot: fact.sourceRoot,
        targetRoot: fact.targetRoot,
        relationPathRoots: [fact.factRoot],
      }),
    );
    return;
  }
  throw new Error(
    "usage: buildchain facts compatibility <project|verify|query|query-template> ...",
  );
}
