import { spawnSync } from "node:child_process";
import { BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY } from "../github-governance-authority.js";
export function normalizeMembership(result) {
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

export function readVerifierSourceRevision(root, run = spawnSync) {
  const result = run("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) throw new Error("verifier source provenance is unavailable");
  return String(result.stdout || "").trim();
}

export function addMinutes(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

export function repositoryVisibility(repository) {
  return String(
    repository.visibility || (repository.private ? "private" : "public"),
  ).toLowerCase();
}

export function selectGithubGovernanceRepositories(
  repositories,
  requested = "",
  descriptor = BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY,
) {
  const exact = requested
    ? repositories.filter(
        (repository) =>
          repository.full_name === requested || repository.name === requested,
      )
    : repositories;
  if (requested && exact.length !== 1) {
    throw new Error("repository selector must resolve exactly once");
  }
  const managedVisibilities = new Set(
    descriptor.repositoryAdmission.managedVisibilities || ["public"],
  );
  const selected = exact.filter((repository) =>
    managedVisibilities.has(repositoryVisibility(repository)),
  );
  if (requested && selected.length !== 1) {
    throw new Error("repository selector is outside managed governance scope");
  }
  return selected;
}
