import path from "node:path";
import {
  createKfdLegacySupportMatrixProjection,
  validateKfdAdopterManifestGate,
  validateKfdLegacySupportMatrixProjection,
} from "../kfd-adopter-manifest.js";
import {
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  readRepeatedFlag,
  readRepeatedJsonInputs,
  writeJsonFile,
} from "../../contracts/cli/options.mjs";

export function runKfdSupportCli(args = []) {
  const [action = "", ...rest] = args;
  const cwd = path.resolve(readFlag(rest, "cwd", process.cwd()));
  const json = readBooleanFlag(rest, "json");
  const requestedCheckedAt = readFlag(rest, "checked-at", "");
  const expectedSourceSha = readFlag(rest, "expected-source-sha", "");
  if (action === "project") {
    const manifestInput = readFlag(rest, "manifest-json", "");
    const gateInput = readFlag(rest, "manifest-gate-json", "");
    if (!manifestInput || !gateInput) {
      throw new Error(
        "buildchain kfd support project requires --manifest-json and --manifest-gate-json",
      );
    }
    const manifest = readJsonInput(manifestInput, {
      cwd,
      label: "KFD adopter manifest",
    });
    const manifestGate = readJsonInput(gateInput, {
      cwd,
      label: "KFD adopter manifest gate",
    });
    const gateValidation = validateKfdAdopterManifestGate(manifestGate, {
      expectedSourceSha,
      checkedAt: requestedCheckedAt || manifestGate.checkedAt,
    });
    if (!gateValidation.valid)
      throw new Error(
        `KFD adopter manifest gate is invalid: ${JSON.stringify(gateValidation.issues)}`,
      );
    const result = createKfdLegacySupportMatrixProjection({
      manifest,
      manifestGate,
    });
    const output = readFlag(rest, "output", "");
    if (output) writeJsonFile(path.resolve(cwd, output), result);
    if (json || !output) {
      printJson(result);
    } else {
      process.stdout.write(`KFD support projection: passed -> ${output}\n`);
    }
    return;
  }
  if (action === "verify") {
    const projectionInput = readFlag(rest, "projection-json", "");
    const manifestInput = readFlag(rest, "manifest-json", "");
    const gateInput = readFlag(rest, "manifest-gate-json", "");
    if (!projectionInput || !manifestInput || !gateInput) {
      throw new Error(
        "buildchain kfd support verify requires --projection-json, --manifest-json, and --manifest-gate-json",
      );
    }
    const manifest = readJsonInput(manifestInput, {
      cwd,
      label: "KFD adopter manifest",
    });
    const manifestGate = readJsonInput(gateInput, {
      cwd,
      label: "KFD adopter manifest gate",
    });
    const gateValidation = validateKfdAdopterManifestGate(manifestGate, {
      expectedSourceSha,
      checkedAt: requestedCheckedAt || manifestGate.checkedAt,
    });
    const result = validateKfdLegacySupportMatrixProjection(
      readJsonInput(projectionInput, { cwd, label: "KFD support projection" }),
      { manifest, manifestGate },
    );
    const issues = [...gateValidation.issues, ...result.issues];
    const report = {
      schemaVersion: 1,
      contract: "kungfu-buildchain-kfd-support-projection-verification",
      ok: issues.length === 0,
      issues,
    };
    if (json) printJson(report);
    else
      process.stdout.write(
        `KFD support projection verify: ${report.ok ? "passed" : "failed"}\n`,
      );
    if (!report.ok) process.exitCode = 1;
    return;
  }
  throw new Error("usage: buildchain kfd support <project|verify> ...");
}
