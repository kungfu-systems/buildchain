#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installationRoot } from "../../runtime/installation-root.js";
import { domainCanonicalBytes } from "../../contracts/canonical-contracts.js";
import { createCampaignContext } from "../stage-capsule/campaign/context.js";
import { seedStageCapsuleCampaign } from "../stage-capsule/campaign/seed.js";
import { resumeStageCapsuleCampaign } from "../stage-capsule/campaign/resume.js";
import { runStageCapsuleCampaign } from "../stage-capsule/campaign/run.js";
import {
  aggregateStageCapsuleCampaign,
  reconcileStageCapsuleCampaign,
} from "../stage-capsule/campaign/aggregate.js";
export function stageCapsuleQualificationCli(args = process.argv.slice(2)) {
  const option = (name, fallback = "") => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const required = (name) => {
    const value = option(name);
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  const action = args[0];
  if (action === "aggregate")
    return aggregateStageCapsuleCampaign({
      directory: path.resolve(required("input-dir")),
      expectedConsumers: option("expected-consumers")
        ? option("expected-consumers")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : undefined,
      output: option("output"),
    });
  if (action === "reconcile")
    return reconcileStageCapsuleCampaign({
      qualificationPath: path.resolve(required("qualification")),
      evidencePath: path.resolve(required("wave-evidence")),
      output: option("output"),
    });
  const runtimeRoot = installationRoot(import.meta.url);
  const context = createCampaignContext({
    runtimeRoot,
    workRoot: required("work-root"),
    platform: required("platform"),
    consumer: required("consumer"),
    runtimeRef: required("runtime-ref"),
    consumerSourceRevision: required("consumer-source-revision"),
    lifecycleEvidenceRoot: option("lifecycle-evidence-root"),
    consumerRoot: option("consumer-root", runtimeRoot),
  });
  if (action === "seed") return seedStageCapsuleCampaign(context);
  if (action === "resume") return resumeStageCapsuleCampaign(context);
  if (action === "campaign")
    return runStageCapsuleCampaign(context, {
      mode: option("stage-capsule-mode", "shadow"),
    });
  if (action === "smoke") {
    context.workRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "buildchain-capsule-"),
    );
    return runStageCapsuleCampaign(context, {
      mode: option("stage-capsule-mode", "shadow"),
    });
  }
  throw new Error(
    "action must be seed, resume, campaign, aggregate, reconcile, or smoke",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = stageCapsuleQualificationCli();
  if (result !== undefined) process.stdout.write(domainCanonicalBytes(result));
}
