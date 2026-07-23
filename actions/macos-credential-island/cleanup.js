import * as core from "@actions/core";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { cleanupState } from "./lib.js";

for (const name of [
  "INPUT_CERTIFICATE_P12_BASE64",
  "INPUT_CERTIFICATE_PASSWORD",
  "INPUT_NOTARY_API_KEY_P8_BASE64",
]) {
  const value = process.env[name] || "";
  if (value) core.setSecret(value);
  delete process.env[name];
}

function runSecurity(args) {
  const result = spawnSync("/usr/bin/security", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw (
      result.error ||
      new Error(`security cleanup failed with status ${result.status}`)
    );
  }
}

const statePath = core.getState("cleanup-state-path");
if (statePath && fs.existsSync(statePath)) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const errors = cleanupState(state, runSecurity);
    if (errors.length > 0)
      core.warning(`credential-island cleanup warnings: ${errors.join("; ")}`);
  } catch (error) {
    core.warning(
      `credential-island post cleanup could not read state: ${error.message}`,
    );
  } finally {
    fs.rmSync(statePath, { force: true });
  }
}
