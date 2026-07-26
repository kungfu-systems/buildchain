#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function createPromotionRoutingEvidence({
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const routing = {
    schemaVersion: 1,
    contract: "buildchain.promotion-routing/v1",
    router: { ref: env.ROUTER_REF, sha: env.ROUTER_SHA },
    shell: {
      channel: env.SHELL_CHANNEL,
      ref: env.SHELL_REF,
      sha: env.SHELL_SHA,
    },
    runtime: {
      requestedRef: env.RUNTIME_REF,
      resolvedSha: env.RUNTIME_SHA,
    },
    contractLock: { path: env.LOCK_PATH, digest: env.LOCK_DIGEST },
    publication: {
      channel: env.PUBLICATION_CHANNEL,
      targetRef: env.TARGET_REF,
    },
    trustedOverrideUsed: env.OVERRIDE_USED === "true",
  };
  const controllerDir = path.join(cwd, ".buildchain", "controller");
  const routingPath = path.join(controllerDir, "promotion-routing.json");
  const candidatePath = path.join(
    controllerDir,
    "release-candidate-promotion-passport.json",
  );
  const candidate = JSON.parse(
    fs.readFileSync(path.resolve(cwd, env.RELEASE_CANDIDATE_PASSPORT), "utf8"),
  );
  fs.mkdirSync(controllerDir, { recursive: true });
  fs.writeFileSync(routingPath, `${JSON.stringify(routing, null, 2)}\n`);
  fs.writeFileSync(
    candidatePath,
    `${JSON.stringify({ ...candidate, promotionRouting: routing }, null, 2)}\n`,
  );
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      env.GITHUB_OUTPUT,
      [
        "routing-path=.buildchain/controller/promotion-routing.json",
        "candidate-passport-path=.buildchain/controller/release-candidate-promotion-passport.json",
        "",
      ].join("\n"),
    );
  }
  return { routing, routingPath, candidatePath };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    createPromotionRoutingEvidence();
  } catch (error) {
    console.error(
      `promotion routing evidence failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

export { createPromotionRoutingEvidence };
