import fs from "node:fs";
import path from "node:path";
import { adopterDeliveryGateDigest } from "../adopter-delivery-json.js";
import { createCrossPlatformAdopterReport } from "../cross-platform-adopter-qualification.js";
import { readJson, writeJson, run, expectPass, resolveInput } from "./io.js";
// Public CLI and independent clean-room execution are the protocol under test.
export function qualifyAdopterPlatform({
  runtimeRoot,
  consumerRoot,
  output,
  inputPath,
  platform,
  consumer,
  runtimeSha,
  consumerSha,
  nodePath = process.execPath,
  env = process.env,
}) {
  const workRoot = path.dirname(output),
    input = resolveInput(consumerRoot, inputPath);
  const cli = path.join(runtimeRoot, "bin/buildchain.mjs");
  const command = (subcommand, args) =>
    run(nodePath, [cli, "adopter-delivery", subcommand, ...args], {
      cwd: consumerRoot,
      env,
    });

  fs.mkdirSync(workRoot, { recursive: true });
  const initialPath = path.join(workRoot, "initial-readback.json");
  const retryPath = path.join(workRoot, "retry-readback.json");
  const terminalPath = path.join(workRoot, "terminal-readback.json");
  const tamperedPath = path.join(workRoot, "tampered-readback.json");

  expectPass(
    command("run", ["--input", input, "--output", initialPath]),
    "initial public adopter delivery",
  );
  const initial = readJson(initialPath);
  const tampered = structuredClone(initial);
  tampered.gateResult.artifact.root = `sha256:${"f".repeat(64)}`;
  writeJson(tamperedPath, tampered);
  const rejected = command("verify", [
    "--input",
    input,
    "--readback",
    tamperedPath,
  ]);
  if (rejected.status === 0)
    throw new Error("tampered public readback was not rejected");
  expectPass(
    command("run", ["--input", input, "--output", retryPath]),
    "retry public adopter delivery",
  );
  const retry = readJson(retryPath);
  expectPass(
    command("verify", [
      "--input",
      input,
      "--readback",
      retryPath,
      "--output",
      terminalPath,
    ]),
    "terminal public adopter delivery readback",
  );
  const terminal = readJson(terminalPath);
  const neutralDriver = run(
    nodePath,
    [
      "--test",
      path.join(
        runtimeRoot,
        "tests/non-kfd-specification-driver-clean-room.test.mjs",
      ),
    ],
    { cwd: runtimeRoot, env },
  );
  expectPass(neutralDriver, "independent protocol-neutral driver");

  const report = createCrossPlatformAdopterReport({
    platform: platform,
    consumer: consumer,
    sourceBinding: {
      runtimeSha: runtimeSha,
      consumerSha: consumerSha,
      inputRoot: adopterDeliveryGateDigest(readJson(input)),
    },
    execution: {
      initialRun: {
        status: "passed",
        readbackRoot: initial.deliveryRoot,
      },
      tamperFailure: {
        status: "failed-as-required",
        exitCode: rejected.status ?? 1,
      },
      retryRun: {
        status: "passed",
        readbackRoot: retry.deliveryRoot,
      },
      terminalVerify: {
        status: "passed",
        readbackRoot: terminal.deliveryRoot,
      },
      neutralDriver: {
        id: "ledger-specification-driver",
        status: "passed",
        kfdDependencyPresent: false,
      },
    },
    authority: {
      productionWrites: false,
      providerEffects: false,
      releaseEffects: false,
      stablePublication: false,
    },
  });
  writeJson(output, report);
  return report;
}
