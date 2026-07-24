#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY,
  compileEffectiveGithubGovernancePolicy,
  evaluateCodeownersAuthority,
  evaluateGithubGovernanceSnapshot,
  githubGovernanceDigest,
  githubRepositoryIdentityRoot,
  resolveGithubGovernanceTargetRefs,
} from "../packages/core/github-governance-authority.js";

const CODEOWNERS_PATHS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
];

function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : String(args[index + 1] || "");
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

function command(commandName, commandArgs, label) {
  const result = spawnSync(commandName, commandArgs, {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      GH_TOKEN: process.env.GH_TOKEN || "",
      GITHUB_TOKEN: process.env.GITHUB_TOKEN || "",
    },
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const statusMatch = output.match(/\b(?:HTTP|status:?)\s*(\d{3})\b/i);
  const status = Number(statusMatch?.[1] || (result.status === 0 ? 200 : 0));
  if (result.status !== 0) {
    return {
      ok: false,
      status,
      reason: /401|unauthorized/i.test(output)
        ? "unauthorized"
        : /403|forbidden/i.test(output)
          ? "forbidden"
          : /404|not found/i.test(output)
            ? "not-found"
            : "unavailable",
      label,
      data: null,
    };
  }
  try {
    return {
      ok: true,
      status,
      reason: "read",
      label,
      data: JSON.parse(result.stdout),
    };
  } catch {
    return {
      ok: false,
      status,
      reason: "invalid-json",
      label,
      data: null,
    };
  }
}

function githubApi(route, label) {
  return command(
    "gh",
    [
      "api",
      route,
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
    ],
    label,
  );
}

function resolvedAbsence(result) {
  return result.ok || result.reason === "not-found";
}

function decodeContent(result) {
  if (!result.ok) return "";
  return Buffer.from(String(result.data?.content || ""), "base64").toString("utf8");
}

function readCodeowners(repository, ref) {
  const attempts = CODEOWNERS_PATHS.map((candidatePath) => {
    const encoded = candidatePath.split("/").map(encodeURIComponent).join("/");
    return {
      path: candidatePath,
      result: githubApi(
        `repos/${repository}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
        `${repository} ${candidatePath}`,
      ),
    };
  });
  const found = attempts.find((attempt) => attempt.result.ok);
  return {
    path: found?.path || "",
    source: found ? decodeContent(found.result) : "",
    readable: attempts.every((attempt) => resolvedAbsence(attempt.result)),
    attempts: attempts.map((attempt) => ({
      path: attempt.path,
      status: attempt.result.ok ? "present" : attempt.result.reason,
    })),
  };
}

function readRulesets(repository) {
  const listing = githubApi(
    `repos/${repository}/rulesets?includes_parents=true&per_page=100`,
    `${repository} rulesets`,
  );
  if (!listing.ok) {
    return {
      readable: listing.reason === "not-found",
      listing,
      rulesets: [],
    };
  }
  const rulesets = [];
  let readable = true;
  for (const entry of Array.isArray(listing.data) ? listing.data : []) {
    if (!entry?.id) continue;
    const detail = githubApi(
      `repos/${repository}/rulesets/${entry.id}`,
      `${repository} ruleset ${entry.id}`,
    );
    readable = readable && detail.ok;
    if (detail.ok) rulesets.push(detail.data);
  }
  return { readable, listing, rulesets };
}

function readBranchNames(repository) {
  const names = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = githubApi(
      `repos/${repository}/branches?per_page=100&page=${page}`,
      `${repository} branches page ${page}`,
    );
    if (!response.ok) {
      return { readable: false, result: response, names: [] };
    }
    const entries = Array.isArray(response.data) ? response.data : [];
    names.push(...entries.map((entry) => String(entry?.name || "")).filter(Boolean));
    if (entries.length < 100) {
      return {
        readable: true,
        result: response,
        names: [...new Set(names)].sort(),
      };
    }
  }
  return {
    readable: false,
    result: {
      ok: false,
      reason: "pagination-limit",
    },
    names: [],
  };
}

function readOrganizationRepositories(organization) {
  const repositories = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = githubApi(
      `orgs/${organization}/repos?per_page=100&type=all&page=${page}`,
      `managed repositories page ${page}`,
    );
    if (!response.ok) {
      return { readable: false, result: response, repositories: [] };
    }
    const entries = Array.isArray(response.data) ? response.data : [];
    repositories.push(...entries);
    if (entries.length < 100) {
      return {
        readable: true,
        result: response,
        repositories,
      };
    }
  }
  return {
    readable: false,
    result: {
      ok: false,
      reason: "pagination-limit",
    },
    repositories: [],
  };
}

function normalizeMembership(result) {
  return result.ok
    ? {
        state: String(result.data?.state || ""),
        role: String(result.data?.role || ""),
      }
    : {
        state: "unreadable",
        role: "unreadable",
      };
}

export function resolveVerifierSourceRevision(
  root,
  requested = process.env.GITHUB_SHA || "",
  run = spawnSync,
) {
  const result = run("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const revision = String(result.stdout || "").trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/i.test(revision)) {
    throw new Error("verifier source revision is unavailable");
  }
  const cleanliness = run("git", ["-C", root, "diff", "--quiet", "HEAD", "--"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (cleanliness.status !== 0) {
    throw new Error("verifier checkout contains tracked drift");
  }
  const normalized = revision.toLowerCase();
  if (requested && (!/^[0-9a-f]{40}$/i.test(requested) ||
      requested.toLowerCase() !== normalized)) {
    throw new Error("requested verifier source revision does not match the current checkout");
  }
  return normalized;
}

function addMinutes(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

function repositorySelector(repositories, requested) {
  if (!requested) return repositories;
  const exact = repositories.filter((repository) =>
    repository.full_name === requested ||
    repository.name === requested);
  if (exact.length !== 1) {
    throw new Error(`repository selector must resolve exactly once: ${requested}`);
  }
  return exact;
}

export function collectGithubGovernanceAudit({
  organization = BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.organization,
  repository = "",
  targetRef = "",
  observedAt = new Date().toISOString(),
  ttlMinutes = 15,
  verifierSourceRevision = "",
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  api = githubApi,
} = {}) {
  if (api !== githubApi) {
    throw new Error("injected API clients must use collectGithubGovernanceAuditFromSnapshot");
  }
  const organizationState = githubApi(`orgs/${organization}`, "organization");
  const repositoriesState = readOrganizationRepositories(organization);
  const developmentMembership = githubApi(
    `orgs/${organization}/memberships/${BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.authority.developmentIdentity}`,
    "development membership",
  );
  const reviewMembership = githubApi(
    `orgs/${organization}/memberships/${BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.authority.reviewIdentity}`,
    "review membership",
  );
  if (!organizationState.ok || !repositoriesState.readable) {
    throw new Error("organization or managed repository inventory is unreadable; governance audit fails closed");
  }
  const selected = repositorySelector(repositoriesState.repositories, repository);
  if (targetRef && selected.length !== 1) {
    throw new Error("--target-ref requires exactly one selected repository");
  }
  const revision = resolveVerifierSourceRevision(root, verifierSourceRevision);
  const verifier = {
    runtime: `node-${process.version}`,
    sourceRevision: revision,
    identityRoot: githubGovernanceDigest({
      contract: BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.contract,
      policyRoot: BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.policyRoot,
      sourceRevision: revision,
      runtime: process.version,
    }),
  };
  const memberships = {
    [BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.authority.developmentIdentity]:
      normalizeMembership(developmentMembership),
    [BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.authority.reviewIdentity]:
      normalizeMembership(reviewMembership),
  };
  const receipts = [];
  const diagnostics = [];
  for (const metadata of selected) {
    const fullName = String(metadata.full_name || "");
    const visibilityClass = String(
      metadata.visibility || (metadata.private ? "private" : "public"),
    );
    const repositoryIdentityRoot = githubRepositoryIdentityRoot({
      provider: "github",
      providerRepositoryId: String(metadata.node_id || metadata.id || ""),
    });
    const defaultBranch = String(metadata.default_branch || "").replace(/^refs\/heads\//, "");
    const repositoryState = {
      fullName,
      visibility: visibilityClass,
      identityRoot: repositoryIdentityRoot,
      defaultBranch,
    };
    const branchesState = targetRef
      ? {
          readable: true,
          result: { ok: true, reason: "targeted-read" },
          names: [String(targetRef).replace(/^refs\/heads\//, "")],
        }
      : readBranchNames(fullName);
    const branches = resolveGithubGovernanceTargetRefs({
      repository: repositoryState,
      availableRefs: branchesState.names,
      requestedTargetRef: targetRef,
    });
    const rulesetState = readRulesets(fullName);
    for (const branch of branches) {
      const branchState = githubApi(
        `repos/${fullName}/branches/${encodeURIComponent(branch)}`,
        `${fullName} branch`,
      );
      const protectionState = githubApi(
        `repos/${fullName}/branches/${encodeURIComponent(branch)}/protection`,
        `${fullName} branch protection`,
      );
      const codeownersState = readCodeowners(fullName, branch);
      const codeowners = evaluateCodeownersAuthority({
        source: codeownersState.source,
        sourcePath: codeownersState.path,
        reviewAuthority: BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.authority.reviewIdentity,
      });
      const effectivePolicy = compileEffectiveGithubGovernancePolicy({
        branch,
        defaultBranch,
        protectedBranch: branchState.data?.protected === true,
        protection: protectionState.ok ? protectionState.data : null,
        rulesets: rulesetState.rulesets,
      });
      const apiEvidence = {
        complete: branchesState.readable &&
          branchState.ok &&
          resolvedAbsence(protectionState) &&
          rulesetState.readable &&
          codeownersState.readable &&
          developmentMembership.ok &&
          reviewMembership.ok,
        readable: branchesState.readable &&
          branchState.ok &&
          rulesetState.readable &&
          codeownersState.readable,
        ambiguous: false,
        provider: "github",
        endpointClasses: {
          organization: organizationState.ok ? "read" : organizationState.reason,
          repositories: repositoriesState.readable
            ? "read"
            : repositoriesState.result.reason,
          branches: branchesState.readable ? "read" : branchesState.result.reason,
          branch: branchState.ok ? "read" : branchState.reason,
          protection: protectionState.ok ? "read" : protectionState.reason,
          rulesets: rulesetState.readable ? "read" : rulesetState.listing.reason,
          codeowners: codeowners.exists
            ? "present"
            : codeownersState.readable
              ? "absent"
              : "unreadable",
          memberships: developmentMembership.ok && reviewMembership.ok
            ? "read"
            : "unreadable",
        },
      };
      receipts.push(evaluateGithubGovernanceSnapshot({
        repository: repositoryState,
        targetRef: branch,
        organizationPlan: String(organizationState.data?.plan?.name || ""),
        codeowners,
        effectivePolicy,
        memberships,
        apiEvidence,
        observedAt,
        expiresAt: addMinutes(observedAt, ttlMinutes),
        verifier,
      }));
      diagnostics.push({
        repositoryIdentityRoot,
        visibility: visibilityClass,
        targetRef: branch,
        endpointClasses: apiEvidence.endpointClasses,
        codeownersAttempts: codeownersState.attempts,
      });
    }
  }
  const visibility = selected.reduce((counts, item) => {
    const key = String(item.visibility || (item.private ? "private" : "public"));
    counts[key] = Number(counts[key] || 0) + 1;
    return counts;
  }, {});
  const core = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-github-governance-audit",
    organization,
    policyRoot: BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.policyRoot,
    organizationPlan: String(organizationState.data?.plan?.name || "unknown"),
    observedAt,
    expiresAt: addMinutes(observedAt, ttlMinutes),
    inventory: {
      repositoryCount: selected.length,
      targetCount: receipts.length,
      visibility,
      qualifyingCount: receipts.filter((receipt) => receipt.qualifying).length,
      nonQualifyingCount: receipts.filter((receipt) => !receipt.qualifying).length,
    },
    receipts,
    diagnostics,
    verifier,
  };
  return { ...core, auditRoot: githubGovernanceDigest(core) };
}

function main(args = process.argv.slice(2)) {
  const result = collectGithubGovernanceAudit({
    organization: flag(args, "organization", BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.organization),
    repository: flag(args, "repository"),
    targetRef: flag(args, "target-ref"),
    observedAt: flag(args, "observed-at", new Date().toISOString()),
    ttlMinutes: Number(flag(args, "ttl-minutes", "15")),
    verifierSourceRevision: flag(args, "source-revision"),
  });
  const output = flag(args, "output");
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (output) fs.writeFileSync(path.resolve(output), serialized);
  if (!output || hasFlag(args, "json")) process.stdout.write(serialized);
  if (hasFlag(args, "require-qualifying") && result.inventory.nonQualifyingCount > 0) {
    process.exitCode = 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
