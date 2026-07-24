#!/usr/bin/env node
import fs from "node:fs";
import {
  getStableReleasePolicy,
  loadBuildchainConfig,
} from "../packages/core/buildchain-config.js";

function writeOutputs(values, outputFile = process.env.GITHUB_OUTPUT) {
  if (!outputFile) return;
  fs.appendFileSync(outputFile, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
}

const cwd = process.env.BUILDCHAIN_STABLE_POLICY_CWD || process.cwd();
const policy = getStableReleasePolicy(loadBuildchainConfig(cwd));
writeOutputs({
  strategy: policy.strategy,
  timezone: policy.timezone,
  "publish-at": policy.publishAt,
  "minimum-soak-seconds": policy.minimumSoakSeconds,
  "required-checks": policy.requiredChecks.join(","),
  "ledger-ref": policy.ledgerRef,
  "auto-promote": policy.autoPromote,
  "auto-merge": policy.autoMerge,
});
process.stdout.write(`${JSON.stringify(policy, null, 2)}\n`);
