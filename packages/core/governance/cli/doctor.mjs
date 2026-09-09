import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { validateBuildchainConfig } from "../../consumer/buildchain-config.js";
import { detectPackageManager } from "../../build/package-manager.js";
import {
  BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT,
  formatDiagnosticsSummaryTable,
  startProcessSampler,
  summarizeDiagnosticsArtifacts,
  summarizeProcessSamples,
  validateAnchoredPackageRelease,
} from "../../observability/diagnostics.js";
import {
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  readRepeatedFlag,
  readRepeatedJsonInputs,
  writeJsonFile,
} from "../../contracts/cli/options.mjs";

export function checkStatus(ok, id, message, details = {}) {
  return { id, status: ok ? "pass" : "fail", message, details };
}

export function runDoctor({
  cwd = process.cwd(),
  requirePublishSourceLock = false,
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const checks = [];
  checks.push(
    checkStatus(
      fs.existsSync(resolvedCwd),
      "cwd.exists",
      "working directory exists",
      { cwd: resolvedCwd },
    ),
  );
  let validation;
  try {
    validation = validateBuildchainConfig(resolvedCwd);
    checks.push(
      checkStatus(true, "config.valid", "buildchain.toml is valid", {
        projectType: validation.project?.type || "",
        lifecycleStages: validation.lifecycleStages.map((stage) => stage.name),
      }),
    );
  } catch (error) {
    checks.push(checkStatus(false, "config.valid", error.message));
  }
  try {
    const manager = detectPackageManager(resolvedCwd);
    checks.push(
      checkStatus(
        true,
        "package-manager.detected",
        `package manager: ${manager.name}`,
        manager,
      ),
    );
  } catch (error) {
    checks.push(checkStatus(false, "package-manager.detected", error.message));
  }
  const git = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: resolvedCwd,
    encoding: "utf8",
  });
  checks.push(
    checkStatus(
      git.status === 0 && git.stdout.trim() === "true",
      "git.repository",
      "directory is a git repository",
    ),
  );
  const workflowPath = path.join(
    resolvedCwd,
    ".github",
    "workflows",
    "build.yml",
  );
  checks.push(
    checkStatus(
      fs.existsSync(workflowPath),
      "workflow.build",
      "reusable workflow caller exists",
      {
        path: ".github/workflows/build.yml",
      },
    ),
  );
  if (
    validation?.version?.strategy === "anchored" &&
    validation.version.next === "manual"
  ) {
    const anchored = validateAnchoredPackageRelease({
      cwd: resolvedCwd,
      requirePublishGateSourceLock: requirePublishSourceLock,
    });
    checks.push(
      checkStatus(
        anchored.ok,
        "anchored-package-release.valid",
        "anchored package release contract is valid",
        {
          contract: anchored.contract,
          summary: anchored.summary,
          checks: anchored.checks,
        },
      ),
    );
  }
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-doctor",
    cwd: resolvedCwd,
    ok: checks.every((check) => check.status === "pass"),
    checks,
    docsUrl: "https://buildchain.libkungfu.dev/docs/cli",
  };
}

export async function handleDoctorCommand(args) {
  const result = runDoctor({
    cwd: readFlag(args, "cwd", process.cwd()),
    requirePublishSourceLock: readBooleanFlag(
      args,
      "require-publish-source-lock",
    ),
  });
  if (readBooleanFlag(args, "json")) {
    printJson(result);
  } else {
    process.stdout.write(`buildchain doctor: ${result.ok ? "ok" : "failed"}\n`);
    for (const check of result.checks) {
      process.stdout.write(
        `- ${check.status}: ${check.id}: ${check.message}\n`,
      );
    }
  }
  return;
}
