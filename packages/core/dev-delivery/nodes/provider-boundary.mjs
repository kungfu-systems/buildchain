import fs from "node:fs";
import { outputs, runtimeCommand } from "./io.mjs";
import {
  command,
  environmentArguments,
} from "../../runtime/action-process.mjs";

export function verifyProviderBoundary(env) {
  const endpoint = `repos/${env.GITHUB_REPOSITORY}`;
  for (const [file, api] of Object.entries({
    "provider-jobs": `${endpoint}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`,
    "provider-pull-request": `${endpoint}/pulls/${env.EXPECTED_PR}`,
    "provider-base-ref": `${endpoint}/git/ref/heads/${env.TARGET_BRANCH}`,
  })) {
    const bytes = command("gh", ["api", api], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    fs.writeFileSync(`.buildchain/${file}.json`, bytes);
  }
  runtimeCommand("dev-delivery-provider-heartbeat", [
    "verify",
    ...environmentArguments(
      {
        repository: "GITHUB_REPOSITORY",
        branch: "TARGET_BRANCH",
        "workflow-run-id": "GITHUB_RUN_ID",
        "workflow-run-attempt": "GITHUB_RUN_ATTEMPT",
      },
      env,
    ),
    "--admission",
    ".buildchain/dev-delivery/warrant.json",
    "--receipt",
    ".buildchain/provider-heartbeat-receipt.json",
    "--jobs-readback",
    ".buildchain/provider-jobs.json",
    "--admission-job-name",
    "Reserve exact delivery candidate",
    "--heartbeat-job-name",
    "Credentialed independent Warrant heartbeat",
    "--finalizer-job-name",
    "Credentialed provider finalizer",
    "--output",
    ".buildchain/provider-heartbeat-verification.json",
  ]);
  runtimeCommand("dev-delivery-process-boundary", [
    "verify",
    "--directory",
    ".buildchain/native-transfer",
    "--jobs-readback",
    ".buildchain/provider-jobs.json",
    "--pull-request-readback",
    ".buildchain/provider-pull-request.json",
    "--base-ref-readback",
    ".buildchain/provider-base-ref.json",
    "--native-job",
    "native-execution",
    "--native-job-name",
    "Credentialless native execution",
    "--seal-job-name",
    "Credentialless native evidence seal",
    "--finalizer-job-name",
    "Credentialed provider finalizer",
    ...environmentArguments(
      {
        "pull-request": "EXPECTED_PR",
        "source-head": "EXPECTED_HEAD",
        "runtime-sha": "ADMITTED_RUNTIME_SHA",
        "runtime-selection-root": "ADMITTED_RUNTIME_ROOT",
      },
      env,
    ),
    "--output",
    ".buildchain/provider-finalizer-boundary.json",
  ]);
  const result = JSON.parse(
    fs.readFileSync(".buildchain/provider-finalizer-boundary.json", "utf8"),
  );
  outputs({
    "transfer-root": result.transferRoot,
    "boundary-root": result.boundaryRoot,
    "native-outcome": result.nativeJob.conclusion,
    "native-job-id": result.nativeJob.id,
    "seal-job-id": result.sealJob.id,
  });
}
