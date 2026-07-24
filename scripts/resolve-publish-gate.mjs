#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolvePublishGate, writeGitHubOutputs } from "./build-contract-core.mjs";

function readEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

export function resolvePublishGateCli() {
  const gate = resolvePublishGate({
    trusted: readEnv("BUILDCHAIN_TRUSTED_EVENT", "true"),
    publishChannel: readEnv("BUILDCHAIN_PUBLISH_CHANNEL", "none"),
    eventName: readEnv("GITHUB_EVENT_NAME", ""),
    ref: readEnv("GITHUB_REF", ""),
    publishRefsJson: readEnv("BUILDCHAIN_PUBLISH_REFS_JSON", ""),
  });
  writeGitHubOutputs({
    "trusted-event": String(gate.trusted),
    "publish-channel": gate.publishChannel,
    "publish-allowed": String(gate.publishAllowed),
    "publish-reason": gate.publishReason,
  });
  return gate;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    resolvePublishGateCli();
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}
