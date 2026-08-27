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
function bundlePromotionControllerEvidence({
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const finalizationNeeded = env.FINALIZATION_NEEDED === "true";
  const files = [
    [env.RELEASE_CANDIDATE_PASSPORT, "release-candidate-passport.json"],
    [env.PUBLISH_EVIDENCE, "publish-evidence.json"],
    ...(!finalizationNeeded
      ? [[env.RELEASE_PASSPORT, "release-passport.json"]]
      : []),
    ...(env.PUBLICATION_COMMIT_ENABLED === "true" && !finalizationNeeded
      ? [[env.PUBLICATION_COMMIT_EVIDENCE, "publication-commit-evidence.json"]]
      : []),
    ...(!finalizationNeeded ? [
      [env.RELEASE_ACTIVATION_RECEIPTS, "release-activation-receipt-set.json"],
      [env.RELEASED_PRODUCT_EVIDENCE, "released-product-evidence.json"],
      [env.RELEASE_PROPAGATION_CAPTURE, "release-propagation-capture.json"],
    ].filter(([source]) => source) : []),
  ];
  const outputDir = path.join(cwd, ".buildchain/controller/promotion-evidence");
  fs.mkdirSync(outputDir, { recursive: true });
  for (const [source, name] of files) {
    if (!source || !fs.existsSync(path.resolve(cwd, source)))
      throw new Error(`promotion controller evidence is missing: ${source || name}`);
    fs.copyFileSync(path.resolve(cwd, source), path.join(outputDir, name));
  }
  return { files: files.map(([, name]) => name), outputDir };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    if (process.argv[2] === "bundle-controller-evidence") {
      bundlePromotionControllerEvidence();
    } else {
      createPromotionRoutingEvidence();
    }
  } catch (error) {
    console.error(
      `promotion routing evidence failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
export { bundlePromotionControllerEvidence, createPromotionRoutingEvidence };
