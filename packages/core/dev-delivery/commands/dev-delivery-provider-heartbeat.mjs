#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { heartbeatDeliveryAttempt, verifyDeliveryHeartbeat } from "../native/heartbeat.js";
function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function readJson(file, label) {
  if (!file) throw new Error(`${label} is required`);
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "";
  if (!new Set(["run", "verify"]).has(command)) {
    process.stdout.write(
      "Usage: dev-delivery-provider-heartbeat.mjs <run|verify> --admission FILE --repository owner/repo --branch dev/vN/vN.M --workflow-run-id N --workflow-run-attempt N --output FILE\n",
    );
    return;
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const common = {
    repository: flag(args, "repository", process.env.GITHUB_REPOSITORY),
    branch: flag(args, "branch", process.env.GITHUB_BASE_REF),
    admission: readJson(flag(args, "admission"), "admission"),
    workflowRunId: Number(process.env.GITHUB_RUN_ID),
    workflowRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    token,
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    now: new Date().toISOString(),
    admissionJobName: flag(
      args,
      "admission-job-name",
      "Reserve exact delivery candidate",
    ),
    heartbeatJobName: flag(
      args,
      "heartbeat-job-name",
      "Credentialed independent Warrant heartbeat",
    ),
    finalizerJobName: flag(
      args,
      "finalizer-job-name",
      "Credentialed provider finalizer",
    ),
  };
  const result =
    command === "run"
      ? await heartbeatDeliveryAttempt({
          ...common,
          leaseSeconds: Number(flag(args, "lease-seconds", "3600")),
          heartbeatSeconds: Number(flag(args, "heartbeat-seconds", "30")),
        })
      : await verifyDeliveryHeartbeat({
          ...common,
          receipt: readJson(flag(args, "receipt"), "heartbeat receipt"),
          jobsReadback: readJson(flag(args, "jobs-readback"), "jobs readback"),
        });
  writeJson(flag(args, "output"), result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`dev delivery provider heartbeat: ${error.message}`);
    process.exit(1);
  });
}
