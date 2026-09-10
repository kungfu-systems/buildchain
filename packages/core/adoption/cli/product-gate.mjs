import path from "node:path";
import {
  checkKfdUpstreamFacts,
  collectKfdAggregate,
  collectKfdStatus,
  collectKfdUpstreamFacts,
  kfd1,
  kfd2,
  layout as buildchainLayout,
  listKfdUpstreamRoles,
  listKfdSchemas,
  normalizeKfdStandardId,
  readKfdSchema,
} from "../kfd.js";
import {
  evaluateKfdProductGate,
  validateKfdProductGateResult,
} from "../kfd-product-gates.js";
import {
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  readRepeatedFlag,
  readRepeatedJsonInputs,
  writeJsonFile,
} from "../../contracts/cli/options.mjs";
import { printKfdSchemaOrJson } from "./output.mjs";

export async function runKfdProductGateCli(standard, args = []) {
  const [rawAction = "schema", ...rest] = args;
  const action = rawAction || "schema";
  const cwd = path.resolve(readFlag(rest, "cwd", process.cwd()));
  const json = readBooleanFlag(rest, "json");
  if (action === "schema") {
    printKfdSchemaOrJson({
      result: readKfdSchema({ standard, schema: readFlag(rest, "schema", "") }),
      json,
    });
    return;
  }
  if (action === "gate") {
    const inputValue = readFlag(rest, "input-json", "");
    if (!inputValue) {
      throw new Error(
        `buildchain kfd ${standard.slice(4)} gate requires --input-json <file-or-json>`,
      );
    }
    const result = await evaluateKfdProductGate({
      cwd,
      input: readJsonInput(inputValue, {
        cwd,
        label: `${standard} product gate input`,
      }),
      expectedSourceSha: readFlag(rest, "expected-source-sha", ""),
      checkedAt: readFlag(rest, "checked-at", "") || new Date().toISOString(),
    });
    const output = readFlag(rest, "output", "");
    if (output) writeJsonFile(path.resolve(cwd, output), result);
    if (json || !output) {
      printJson(result);
    } else {
      process.stdout.write(
        `${standard} product gate: ${result.status} -> ${output}\n`,
      );
      for (const entry of result.issues) {
        process.stdout.write(
          `- ${entry.code}: ${entry.path}: ${entry.message}\n`,
        );
      }
    }
    if (result.status !== "passed") process.exitCode = 1;
    return;
  }
  if (action === "verify") {
    const gateValue = readFlag(rest, "gate-json", "");
    if (!gateValue) {
      throw new Error(
        `buildchain kfd ${standard.slice(4)} verify requires --gate-json <file-or-json>`,
      );
    }
    const gate = readJsonInput(gateValue, {
      cwd,
      label: `${standard} product gate result`,
    });
    const validation = validateKfdProductGateResult(gate, {
      expectedSourceSha: readFlag(rest, "expected-source-sha", ""),
      checkedAt: readFlag(rest, "checked-at", "") || new Date().toISOString(),
    });
    const result = {
      schemaVersion: 1,
      contract: "kungfu-buildchain-kfd-product-gate-verification",
      valid: validation.valid,
      passed: validation.valid && gate.status === "passed",
      standard: gate.standard || standard,
      gateRoot: gate.gateRoot || "",
      issues: validation.issues,
    };
    if (json) printJson(result);
    else
      process.stdout.write(
        `${standard} product gate verify: ${result.passed ? "passed" : "failed"}\n`,
      );
    if (!result.passed) process.exitCode = 1;
    return;
  }
  throw new Error(
    `usage: buildchain kfd ${standard.slice(4)} <schema|gate|verify> ...`,
  );
}
