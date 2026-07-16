#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { createWebSurfaceProductionDecision } from "../packages/core/web-surface-publication-candidate.js";

const TRUSTED_PERMISSIONS = new Set(["write", "maintain", "admin"]);

export function resolveWebSurfaceProductionDecision({
  eventName,
  refName,
  repository,
  sourceSha,
  actor,
  productionApply,
  productionApproved,
  productionReleaseOnMain,
  actorPermission = "",
  releaseApproved = false,
  releasePr = 0,
  releaseSource = "",
} = {}) {
  if (
    eventName === "workflow_dispatch" &&
    productionApply === true &&
    productionApproved === true
  ) {
    const trusted = TRUSTED_PERMISSIONS.has(String(actorPermission));
    return createWebSurfaceProductionDecision({
      approved: trusted,
      kind: trusted ? "manual-dispatch" : "none",
      repository,
      sourceSha,
      actor,
      actorPermission,
      reason: trusted ? "trusted-manual-dispatch" : "manual-actor-permission-insufficient",
    });
  }
  if (
    eventName === "push" &&
    refName === "main" &&
    productionApply === true &&
    productionReleaseOnMain === true &&
    releaseApproved === true
  ) {
    return createWebSurfaceProductionDecision({
      approved: true,
      kind: "release-pr",
      repository,
      sourceSha,
      actor,
      releasePr,
      releaseSource,
      reason: "reviewed-release-pr-merged",
    });
  }
  return createWebSurfaceProductionDecision({
    approved: false,
    kind: "none",
    repository,
    sourceSha,
    actor,
    actorPermission,
    releasePr,
    releaseSource,
    reason: "no-authorizing-production-event",
  });
}

async function actorPermission(repository, actor, token, apiUrl) {
  const response = await fetch(
    `${apiUrl}/repos/${repository}/collaborators/${encodeURIComponent(actor)}/permission`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`could not resolve production actor permission: GitHub API ${response.status}`);
  }
  return String((await response.json()).permission || "");
}

function bool(name) {
  return String(process.env[name] || "") === "true";
}

async function main() {
  const eventName = String(process.env.GITHUB_EVENT_NAME || "");
  const repository = String(process.env.GITHUB_REPOSITORY || "");
  const actor = String(process.env.GITHUB_ACTOR || "");
  let permission = "";
  if (eventName === "workflow_dispatch" && bool("BUILDCHAIN_PRODUCTION_APPLY")) {
    permission = await actorPermission(
      repository,
      actor,
      String(process.env.GITHUB_TOKEN || ""),
      String(process.env.GITHUB_API_URL || "https://api.github.com"),
    );
  }
  const decision = resolveWebSurfaceProductionDecision({
    eventName,
    refName: process.env.GITHUB_REF_NAME,
    repository,
    sourceSha: process.env.GITHUB_SHA,
    actor,
    productionApply: bool("BUILDCHAIN_PRODUCTION_APPLY"),
    productionApproved: bool("BUILDCHAIN_PRODUCTION_APPROVED"),
    productionReleaseOnMain: bool("BUILDCHAIN_PRODUCTION_RELEASE_ON_MAIN"),
    actorPermission: permission,
    releaseApproved: bool("BUILDCHAIN_PRODUCTION_RELEASE_APPROVED"),
    releasePr: Number(process.env.BUILDCHAIN_PRODUCTION_RELEASE_PR || 0),
    releaseSource: process.env.BUILDCHAIN_PRODUCTION_RELEASE_SOURCE,
  });
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `approved=${decision.approved}\ndecision-json=${JSON.stringify(decision)}\n`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Web production decision\n\n- approved: \`${decision.approved}\`\n- kind: \`${decision.kind}\`\n- reason: \`${decision.reason}\`\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`web-surface production decision: ${error.message}`);
    process.exitCode = 1;
  });
}
