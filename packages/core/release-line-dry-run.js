import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  getLifecycleStage,
  getVersionStrategy,
  loadBuildchainConfig,
  loadConfiguredAnchorManifest,
} from "./buildchain-config.js";

const MAJOR_GATE_REF = "publish-gate/major";
const LEGACY_MAJOR_GATE_REF = "major-gate";

function assertShaIfPresent(sha) {
  if (sha && !/^[0-9a-f]{40}$/i.test(String(sha))) {
    throw new Error(`Invalid commit SHA: ${sha}`);
  }
}

function parseTags(input) {
  const tags = Array.isArray(input)
    ? input.map((tag) => String(tag).trim()).filter(Boolean)
    : String(input || "").split(",").map((tag) => tag.trim()).filter(Boolean);
  for (const tag of tags) {
    if (
      !/^v\d+$|^v\d+\.\d+$|^v\d+\.\d+-alpha$|^v\d+\.\d+\.\d+$|^v\d+\.\d+\.\d+-alpha\.\d+$/.test(tag)
    ) {
      throw new Error(`Unsupported buildchain dry-run tag: ${tag}`);
    }
  }
  return [...new Set(tags)];
}

function getPromotionRule(targetRef, sourceRef = "") {
  if (targetRef === MAJOR_GATE_REF || targetRef === LEGACY_MAJOR_GATE_REF) {
    const sourceMatch = String(sourceRef || "").match(/^release\/v(\d+)\/v(\d+)\.(\d+)$/);
    const sourceMajor = sourceMatch ? Number(sourceMatch[1]) : undefined;
    const nextMajor = sourceMajor ? sourceMajor + 1 : undefined;
    return {
      channel: "major",
      targetRef,
      sourceRef: sourceRef || "release/vN/vN.M",
      releasePrefix: nextMajor ? `v${nextMajor}.0` : "v(N+1).0",
      majorTag: nextMajor ? `v${nextMajor}` : "v(N+1)",
      minorTag: nextMajor ? `v${nextMajor}.0` : "v(N+1).0",
      alphaTag: nextMajor ? `v${nextMajor}.0-alpha` : "v(N+1).0-alpha",
      exactReleasePattern: nextMajor ? `v${nextMajor}.0.0` : "v(N+1).0.0",
      exactAlphaPattern: nextMajor ? `v${nextMajor}.0.1-alpha.0` : "v(N+1).0.1-alpha.0",
    };
  }
  const match = String(targetRef || "").match(/^(alpha|release)\/v(\d+)\/v(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(
      `Release dry-run target must be alpha/vN/vN.M, release/vN/vN.M, publish-gate/major, or major-gate; got ${targetRef}`,
    );
  }
  const channel = match[1];
  const major = Number(match[2]);
  const minorMajor = Number(match[3]);
  const minor = Number(match[4]);
  if (major !== minorMajor) {
    throw new Error(`Release dry-run target major mismatch: ${targetRef}`);
  }
  const releasePrefix = `v${major}.${minor}`;
  return {
    channel,
    targetRef,
    major,
    minor,
    releasePrefix,
    majorTag: `v${major}`,
    minorTag: releasePrefix,
    alphaTag: `${releasePrefix}-alpha`,
    sourceRef: channel === "alpha" ? `dev/v${major}/v${major}.${minor}` : `alpha/v${major}/v${major}.${minor}`,
    exactReleasePattern: `${releasePrefix}.Z`,
    exactAlphaPattern: `${releasePrefix}.Z-alpha.N`,
  };
}

function discoverVersionFiles(cwd, loadedConfig) {
  if (loadedConfig?.config?.version?.files?.length) {
    return {
      manager: "buildchain.toml",
      files: loadedConfig.config.version.files.map((file) => file.path).filter(Boolean),
      reason: "configured-version-files",
    };
  }
  const files = [];
  for (const relativePath of ["lerna.json", "package.json"]) {
    const filePath = path.join(cwd, relativePath);
    if (fs.existsSync(filePath)) {
      try {
        const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (typeof json.version === "string") {
          files.push(relativePath);
        }
      } catch {
        // Keep dry-run advisory-only. Validation catches malformed files elsewhere.
      }
    }
  }
  return {
    manager: files.length ? "package-manager" : "none",
    files,
    reason: files.length ? "default-node-version-files" : "no-version-state-discovered",
  };
}

function currentGitHead(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function firstMatching(tags, pattern) {
  return tags.find((tag) => pattern.test(tag)) || "";
}

function explainReleaseLineDryRun({
  cwd = process.cwd(),
  targetRef,
  sha = "",
  sourceRef = "",
  tags,
  publishTransaction = false,
  publishCommand = "",
} = {}) {
  if (!targetRef) {
    throw new Error("release dry-run requires --target-ref");
  }
  const resolvedSha = sha || currentGitHead(cwd);
  assertShaIfPresent(resolvedSha);
  const explicitTags = parseTags(tags);
  const rule = getPromotionRule(targetRef, sourceRef);
  const loadedConfig = loadBuildchainConfig(cwd);
  const versionFiles = discoverVersionFiles(cwd, loadedConfig);
  const versionStrategy = getVersionStrategy(loadedConfig);
  const anchorManifest = loadConfiguredAnchorManifest(cwd, loadedConfig);
  const lifecycleVerify = getLifecycleStage(loadedConfig, "verify");
  const lifecyclePublish = getLifecycleStage(loadedConfig, "publish");
  const publishEnabled = Boolean(publishTransaction || publishCommand || lifecyclePublish);

  const plan = {
    schemaVersion: 1,
    dryRun: true,
    cwd,
    targetRef,
    source: {
      expectedHeadRef: rule.sourceRef,
      sha: resolvedSha || "unknown",
    },
    channel: rule.channel,
    line: rule.releasePrefix,
    exactTags: [],
    floatingRefs: [],
    branchUpdates: [],
    versionState: {
      manager: versionFiles.manager,
      files: versionFiles.files,
      reason: versionFiles.reason,
      strategy: versionStrategy.strategy,
      next: versionStrategy.next,
      anchorManifest: anchorManifest?.path || "",
      verification: lifecycleVerify ? "lifecycle.verify" : "not-configured",
    },
    governanceChecks: [
      "target branch protection must be readable",
      "branch protection must enforce administrators",
      "required pull request review must be enabled",
      "strict required status check must include the Verify check",
      `source PR must be a merged same-repository PR from ${rule.sourceRef} to ${targetRef}`,
    ],
    publishTransaction: {
      enabled: publishEnabled,
      source: publishCommand ? "publish-command" : lifecyclePublish ? "lifecycle.publish" : publishTransaction ? "workflow-input" : "none",
      behavior: publishEnabled
        ? "would create or resume durable release transaction and require publish evidence before public refs move"
        : "not part of this dry-run unless lifecycle.publish or publish transaction input is enabled",
    },
    notes: [],
  };

  if (rule.channel === "alpha") {
    const exactAlpha = firstMatching(explicitTags, /^v\d+\.\d+\.\d+-alpha\.\d+$/) || `next ${rule.exactAlphaPattern}`;
    plan.exactTags.push({
      tag: exactAlpha,
      kind: "alpha",
      action: "would create or reuse immutable alpha evidence tag",
    });
    plan.floatingRefs.push({ ref: rule.alphaTag, kind: "tag", action: "would move to alpha version-state commit" });
    plan.branchUpdates.push(
      { ref: targetRef, action: "would move to alpha version-state commit" },
      { ref: `dev/v${rule.major}/v${rule.major}.${rule.minor}`, action: "would align dev with the published alpha state" },
    );
    plan.versionState.targetVersions = [exactAlpha.replace(/^next v?/, "").replace(/^v/, "")];
    plan.notes.push("Alpha promotion opens or advances the test channel; it does not move production refs.");
  } else if (rule.channel === "release") {
    const exactRelease = firstMatching(explicitTags, /^v\d+\.\d+\.\d+$/) || `next ${rule.exactReleasePattern}`;
    const exactAlpha = firstMatching(explicitTags, /^v\d+\.\d+\.\d+-alpha\.\d+$/) || `next ${rule.releasePrefix}.(Z+1)-alpha.0`;
    plan.exactTags.push(
      { tag: exactRelease, kind: "release", action: "would create or reuse immutable production evidence tag" },
      { tag: exactAlpha, kind: "next-alpha", action: "would create or reuse immutable next-alpha evidence tag" },
    );
    plan.floatingRefs.push(
      { ref: rule.minorTag, kind: "tag", action: "would move to production release commit" },
      { ref: rule.majorTag, kind: "tag", action: "would move when no newer minor line owns the major tag" },
      { ref: rule.alphaTag, kind: "tag", action: "would move to next alpha version-state commit" },
    );
    plan.branchUpdates.push(
      { ref: targetRef, action: "would move to production release commit" },
      { ref: `alpha/v${rule.major}/v${rule.major}.${rule.minor}`, action: "would move to next alpha version-state commit" },
      { ref: `dev/v${rule.major}/v${rule.major}.${rule.minor}`, action: "would move to next alpha version-state commit" },
    );
    plan.governanceChecks.push("release source tree must match the same-patch exact alpha tag tree except generated version-state files or anchored/manual version material");
    plan.versionState.targetVersions = [
      exactRelease.replace(/^next v?/, "").replace(/^v/, ""),
      exactAlpha.replace(/^next v?/, "").replace(/^v/, ""),
    ];
    plan.notes.push("Release promotion publishes production and immediately prepares the next alpha state for the same minor line.");
  } else {
    const exactRelease = firstMatching(explicitTags, /^v\d+\.\d+\.0$/) || rule.exactReleasePattern;
    const exactAlpha = firstMatching(explicitTags, /^v\d+\.\d+\.1-alpha\.0$/) || rule.exactAlphaPattern;
    plan.exactTags.push(
      { tag: exactRelease, kind: "release", action: "would create the first production patch of the next major line" },
      { tag: exactAlpha, kind: "next-alpha", action: "would prepare the first next-alpha patch of the next major line" },
    );
    plan.floatingRefs.push(
      { ref: rule.minorTag, kind: "tag", action: "would move to next-major release commit" },
      { ref: rule.majorTag, kind: "tag", action: "would move to next-major release commit" },
      { ref: rule.alphaTag, kind: "tag", action: "would move to next-major alpha commit" },
    );
    plan.branchUpdates.push(
      { ref: targetRef, action: "would move to next-major release commit" },
      { ref: `release/${rule.majorTag}/${rule.minorTag}`, action: "would move to next-major release commit" },
      { ref: `alpha/${rule.majorTag}/${rule.minorTag}`, action: "would move to next-major alpha commit" },
      { ref: `dev/${rule.majorTag}/${rule.minorTag}`, action: "would move to next-major alpha commit and become the default branch" },
    );
    plan.versionState.targetVersions = [
      exactRelease.replace(/^v/, ""),
      exactAlpha.replace(/^v/, ""),
    ];
    plan.notes.push("Major promotion is a reviewed administrator gate; the gate branch is a frozen release source, not an active trunk.");
  }

  if (versionFiles.files.length === 0) {
    plan.notes.push("No version-state file was discovered; strict promotion would fail unless the caller disables required version state.");
  }
  if (versionStrategy.next === "manual") {
    plan.notes.push("Manual next-anchor strategy means production release will stop with next-anchor-required instead of auto-preparing the next alpha.");
  }
  return plan;
}

function formatReleaseLineDryRun(plan) {
  const lines = [
    "Buildchain release dry-run",
    `- target ref: ${plan.targetRef}`,
    `- expected source: ${plan.source.expectedHeadRef}`,
    `- source sha: ${plan.source.sha}`,
    `- channel: ${plan.channel}`,
    `- line: ${plan.line}`,
    "- exact tags:",
    ...plan.exactTags.map((tag) => `  - ${tag.tag}: ${tag.action}`),
    "- branch updates:",
    ...plan.branchUpdates.map((update) => `  - ${update.ref}: ${update.action}`),
    "- floating refs:",
    ...plan.floatingRefs.map((update) => `  - ${update.ref}: ${update.action}`),
    `- version state: ${plan.versionState.manager} (${plan.versionState.reason})`,
  ];
  if (plan.versionState.files.length > 0) {
    lines.push(`  - files: ${plan.versionState.files.join(", ")}`);
  }
  lines.push(
    `  - strategy: ${plan.versionState.strategy}/${plan.versionState.next}`,
    `  - verification: ${plan.versionState.verification}`,
    `- publish transaction: ${plan.publishTransaction.enabled ? "enabled" : "not enabled"} (${plan.publishTransaction.source})`,
    "- governance checks:",
    ...plan.governanceChecks.map((check) => `  - ${check}`),
  );
  if (plan.notes.length > 0) {
    lines.push("- notes:", ...plan.notes.map((note) => `  - ${note}`));
  }
  lines.push("No refs, tags, packages, or files were modified.");
  return `${lines.join("\n")}\n`;
}

export {
  explainReleaseLineDryRun,
  formatReleaseLineDryRun,
};
