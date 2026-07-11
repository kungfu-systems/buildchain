#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  createStableCandidateLedger,
  markStableCandidatePromoted,
  qualifyStableCandidate,
  registerStableCandidate,
  revokeStableCandidate,
  selectStableCandidate,
  setStableCandidateHold,
  stableCandidatePromotionRefs,
} from "../packages/core/stable-candidate-ledger.js";

const LEDGER_PATH = ".buildchain/stable-candidate-ledger.json";

function text(value = "") {
  return String(value ?? "").trim();
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function list(value) {
  return [...new Set(String(value || "").split(/[\n,]+/).map((entry) => entry.trim()).filter(Boolean))];
}

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function repository(value) {
  const normalized = text(value);
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    throw new Error(`repository must be owner/repo, got ${value || "<empty>"}`);
  }
  return normalized;
}

function targetBranch(value) {
  const normalized = text(value).replace(/^refs\/heads\//, "");
  if (!/^release\/v\d+\/v\d+\.\d+$/.test(normalized)) {
    throw new Error(`target branch must be release/vN/vN.M, got ${value || "<empty>"}`);
  }
  return normalized;
}

function defaultLedgerRef(branch) {
  return `buildchain/candidate-ledger/${branch.replace(/^release\//, "")}`;
}

export function normalizeStableCandidatePatrolOptions(options = {}) {
  const target = targetBranch(options.targetBranch ?? process.env.BUILDCHAIN_STABLE_PATROL_TARGET_BRANCH);
  return {
    repository: repository(options.repository ?? process.env.BUILDCHAIN_STABLE_PATROL_REPOSITORY ?? process.env.GITHUB_REPOSITORY),
    targetBranch: target,
    ledgerRef: text(options.ledgerRef ?? process.env.BUILDCHAIN_STABLE_PATROL_LEDGER_REF) || defaultLedgerRef(target),
    minimumSoakSeconds: integer(options.minimumSoakSeconds ?? process.env.BUILDCHAIN_STABLE_PATROL_MINIMUM_SOAK_SECONDS, 3600),
    requiredChecks: list((options.requiredChecks ?? process.env.BUILDCHAIN_STABLE_PATROL_REQUIRED_CHECKS) || "alpha-release"),
    revokedVersions: list(options.revokedVersions ?? process.env.BUILDCHAIN_STABLE_PATROL_REVOKED_VERSIONS),
    revokeReason: text(options.revokeReason ?? process.env.BUILDCHAIN_STABLE_PATROL_REVOKE_REASON) || "repository-policy-revocation",
    hold: bool(options.hold ?? process.env.BUILDCHAIN_STABLE_PATROL_HOLD, false),
    holdReason: text(options.holdReason ?? process.env.BUILDCHAIN_STABLE_PATROL_HOLD_REASON),
    releaseNow: text(options.releaseNow ?? process.env.BUILDCHAIN_STABLE_PATROL_RELEASE_NOW).replace(/^v/, ""),
    autoPromote: bool(options.autoPromote ?? process.env.BUILDCHAIN_STABLE_PATROL_AUTO_PROMOTE, false),
    autoMerge: bool(options.autoMerge ?? process.env.BUILDCHAIN_STABLE_PATROL_AUTO_MERGE, false),
    dryRun: bool(options.dryRun ?? process.env.BUILDCHAIN_STABLE_PATROL_DRY_RUN, true),
    now: text(options.now ?? process.env.BUILDCHAIN_STABLE_PATROL_NOW) || new Date().toISOString(),
    outputPath: text(options.outputPath ?? process.env.BUILDCHAIN_STABLE_PATROL_OUTPUT_PATH) || ".buildchain/patrol/stable-candidate.json",
  };
}

function targetLinePrefix(branch) {
  const match = branch.match(/^release\/v(\d+)\/v(\d+)\.(\d+)$/);
  return `${match[2]}.${match[3]}.`;
}

function alphaRelease(release, prefix) {
  const version = text(release.tag_name).replace(/^v/, "");
  return release.prerelease === true && version.startsWith(prefix) && /^\d+\.\d+\.\d+-alpha\.\d+$/.test(version)
    ? { version, publishedAt: release.published_at, url: release.html_url, actor: release.author?.login || "", releasePublished: true }
    : undefined;
}

function checkObservation(name, evidence, fallbackCompletedAt) {
  if (name === "alpha-release") {
    return {
      id: name,
      status: evidence.releasePublished ? "pass" : "fail",
      completedAt: evidence.releasePublished ? fallbackCompletedAt : "",
      evidenceUrl: evidence.releaseUrl || "",
    };
  }
  const [kind, explicitName] = name.includes(":") ? name.split(/:(.*)/s, 2) : ["", name];
  const expected = explicitName || name;
  if (kind === "workflow") {
    const run = (evidence.workflowRuns || []).find((entry) => entry.name === expected || entry.path?.endsWith(`/${expected}`));
    return {
      id: name,
      status: run?.conclusion === "success" ? "pass" : "fail",
      completedAt: run?.updated_at || "",
      evidenceUrl: run?.html_url || "",
    };
  }
  const status = (evidence.statuses || []).find((entry) => entry.context === expected);
  if (status) {
    return {
      id: name,
      status: status.state === "success" ? "pass" : "fail",
      completedAt: status.updated_at || "",
      evidenceUrl: status.target_url || "",
    };
  }
  const run = (evidence.checkRuns || []).find((entry) => entry.name === expected || (!kind && entry.name?.includes(expected)));
  return {
    id: name,
    status: run?.conclusion === "success" ? "pass" : "fail",
    completedAt: run?.completed_at || "",
    evidenceUrl: run?.html_url || "",
  };
}

export async function runStableCandidatePatrol(optionsInput = {}, clientInput) {
  const options = normalizeStableCandidatePatrolOptions(optionsInput);
  const client = clientInput || createGitHubStableCandidateClient({
    repository: options.repository,
    token: process.env.GITHUB_TOKEN,
  });
  const stored = await client.readLedger(options.ledgerRef, LEDGER_PATH);
  let ledger = stored?.ledger || createStableCandidateLedger({
    repository: options.repository,
    targetBranch: options.targetBranch,
    now: options.now,
  });

  const releases = await client.listReleases();
  const prefix = targetLinePrefix(options.targetBranch);
  const releaseDiscoveries = releases.map((release) => alphaRelease(release, prefix)).filter(Boolean);
  const tagDiscoveries = await client.listAlphaTags?.(prefix) || [];
  const discoveryByVersion = new Map(tagDiscoveries.map((candidate) => [candidate.version, candidate]));
  for (const release of releaseDiscoveries) {
    discoveryByVersion.set(release.version, { ...discoveryByVersion.get(release.version), ...release });
  }
  const discoveries = [...discoveryByVersion.values()];
  for (const discovery of discoveries) {
    const candidateSha = discovery.sha || await client.resolveTagSha(`v${discovery.version}`);
    ledger = registerStableCandidate(ledger, { ...discovery, sha: candidateSha }, { now: options.now });
    const evidence = await client.getCommitEvidence(candidateSha);
    ledger = qualifyStableCandidate(ledger, {
      version: discovery.version,
      sha: candidateSha,
      actor: "buildchain-patrol",
      checks: options.requiredChecks.map((name) => checkObservation(name, {
        ...evidence,
        releaseUrl: discovery.url,
        releasePublished: discovery.releasePublished === true,
      }, discovery.publishedAt)),
    }, { minimumSoakSeconds: options.minimumSoakSeconds, now: options.now });
  }

  for (const version of options.revokedVersions) {
    const candidate = ledger.candidates.find((entry) => entry.version === version.replace(/^v/, ""));
    if (candidate && candidate.state !== "promoted") {
      ledger = revokeStableCandidate(ledger, version, {
        reason: options.revokeReason,
        actor: "repository-policy",
        now: options.now,
      });
    }
  }
  ledger = setStableCandidateHold(ledger, options.hold, {
    reason: options.hold ? options.holdReason || "repository hold" : "",
    now: options.now,
  });

  for (const candidate of [...ledger.candidates]) {
    if (candidate.state === "promoted" || !candidate.promotionRequest?.stableTag) continue;
    const stable = releases.find((release) => release.tag_name === candidate.promotionRequest.stableTag && release.prerelease !== true);
    if (!stable) continue;
    ledger = markStableCandidatePromoted(ledger, candidate.version, {
      stableTag: stable.tag_name,
      stableSha: await client.resolveTagSha(stable.tag_name),
      now: stable.published_at || options.now,
    });
    if (candidate.promotionRequest?.authority === "human") {
      await client.deleteVariable?.("BUILDCHAIN_STABLE_RELEASE_NOW");
      await client.deleteVariable?.("BUILDCHAIN_STABLE_RELEASE_REASON");
    }
  }

  const publishedStableVersions = releases
    .filter((release) => release.prerelease !== true && /^v\d+\.\d+\.\d+$/.test(text(release.tag_name)))
    .map((release) => ({
      version: text(release.tag_name).replace(/^v/, ""),
      tag: text(release.tag_name),
      publishedAt: release.published_at || "",
      url: release.html_url || "",
    }));
  ledger.stableReleases = publishedStableVersions;
  for (const candidate of ledger.candidates) {
    const stable = publishedStableVersions.find((entry) => entry.version === candidate.stableVersion);
    if (!stable || ["promoted", "revoked"].includes(candidate.state)) continue;
    ledger = revokeStableCandidate(ledger, candidate.version, {
      reason: `stable-version-already-published:${stable.tag}`,
      actor: "buildchain-patrol",
      now: stable.publishedAt || options.now,
    });
  }

  const selection = selectStableCandidate(ledger, { releaseNow: options.releaseNow, now: options.now });
  let promotion;
  if (selection.selected) {
    const refs = stableCandidatePromotionRefs(selection.candidate, options.targetBranch);
    promotion = { ...refs, candidateVersion: selection.candidate.version, candidateSha: selection.candidate.sha };
    if (options.autoPromote && !options.dryRun) {
      if (selection.reason === "human-release-now") {
        await client.setVariable?.("BUILDCHAIN_STABLE_RELEASE_NOW", selection.candidate.version);
        await client.setVariable?.(
          "BUILDCHAIN_STABLE_RELEASE_REASON",
          `Buildchain Stable Candidate Patrol human release-now for ${selection.candidate.version}`,
        );
      }
      await client.ensureBranch(refs.sourceRef, selection.candidate.sha);
      const pullRequest = await client.ensurePromotionPullRequest({
        head: refs.sourceRef,
        base: refs.targetRef,
        title: `Release ${refs.stableTag} from qualified ${refs.exactAlphaTag}`,
        body: [
          "Buildchain qualified-alpha stable promotion.",
          "",
          `- Candidate: \`${refs.exactAlphaTag}\``,
          `- Candidate SHA: \`${selection.candidate.sha}\``,
          `- Selection: \`${selection.reason}\``,
          `- Ledger ref: \`${options.ledgerRef}\``,
          "",
          "The source-lock branch freezes the exact candidate; newer alpha publications do not alter this PR.",
        ].join("\n"),
      });
      if (options.autoMerge) await client.enableAutoMerge(pullRequest);
      promotion.pullRequest = pullRequest;
      const storedCandidate = ledger.candidates.find((entry) => entry.version === selection.candidate.version);
      storedCandidate.promotionRequest = {
        stableTag: refs.stableTag,
        sourceRef: refs.sourceRef,
        targetRef: refs.targetRef,
        pullRequestUrl: pullRequest.html_url || pullRequest.url || "",
        requestedAt: options.now,
        authority: selection.authority,
      };
      if (selection.reason === "human-release-now") {
        storedCandidate.decision = { reason: "human-release-now", actor: "human", updatedAt: options.now };
      }
    }
  }

  if (!options.dryRun) {
    await client.writeLedger(options.ledgerRef, LEDGER_PATH, ledger, stored?.sha);
  }
  const result = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-stable-candidate-patrol",
    repository: options.repository,
    targetBranch: options.targetBranch,
    ledgerRef: options.ledgerRef,
    dryRun: options.dryRun,
    selection,
    promotion,
    summary: {
      discovered: discoveries.length,
      soaking: ledger.candidates.filter((entry) => entry.state === "soaking").length,
      qualified: ledger.candidates.filter((entry) => entry.state === "qualified").length,
      revoked: ledger.candidates.filter((entry) => entry.state === "revoked").length,
      promoted: ledger.candidates.filter((entry) => entry.state === "promoted").length,
    },
    ledger,
  };
  return result;
}

function encodeRef(ref) {
  return ref.split("/").map(encodeURIComponent).join("/");
}

export function createGitHubStableCandidateClient({ repository: repositoryInput, token, fetchImpl = globalThis.fetch }) {
  const [owner, repo] = repository(repositoryInput).split("/");
  const headers = {
    accept: "application/vnd.github+json",
    authorization: token ? `Bearer ${token}` : undefined,
    "user-agent": "buildchain-stable-candidate-patrol",
    "x-github-api-version": "2022-11-28",
  };
  async function api(requestPath, { method = "GET", body, allow404 = false } = {}) {
    const response = await fetchImpl(`https://api.github.com${requestPath}`, {
      method,
      headers: Object.fromEntries(Object.entries(headers).filter(([, value]) => value)),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    const payload = raw ? JSON.parse(raw) : undefined;
    if (allow404 && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub API ${method} ${requestPath} failed with ${response.status}: ${payload?.message || raw}`);
    return payload;
  }
  return {
    async listReleases() {
      return api(`/repos/${owner}/${repo}/releases?per_page=100`);
    },
    async listAlphaTags(prefix) {
      const refs = await api(`/repos/${owner}/${repo}/git/matching-refs/tags/${encodeRef(`v${prefix}`)}`);
      const candidates = [];
      for (const ref of refs) {
        const tag = text(ref.ref).replace(/^refs\/tags\//, "");
        const version = tag.replace(/^v/, "");
        if (!/^\d+\.\d+\.\d+-alpha\.\d+$/.test(version)) continue;
        const candidateSha = await this.resolveTagSha(tag);
        const commit = await api(`/repos/${owner}/${repo}/commits/${candidateSha}`);
        candidates.push({
          version,
          sha: candidateSha,
          publishedAt: commit.commit?.committer?.date || commit.commit?.author?.date,
          url: ref.url || "",
          actor: commit.committer?.login || commit.author?.login || "",
          releasePublished: false,
        });
      }
      return candidates;
    },
    async resolveTagSha(tag) {
      const ref = await api(`/repos/${owner}/${repo}/git/ref/tags/${encodeRef(tag)}`);
      if (ref.object?.type !== "tag") return ref.object?.sha || "";
      const annotated = await api(`/repos/${owner}/${repo}/git/tags/${ref.object.sha}`);
      return annotated.object?.sha || "";
    },
    async getCommitEvidence(candidateSha) {
      const [statuses, checks, workflows] = await Promise.all([
        api(`/repos/${owner}/${repo}/commits/${candidateSha}/statuses?per_page=100`),
        api(`/repos/${owner}/${repo}/commits/${candidateSha}/check-runs?per_page=100`),
        api(`/repos/${owner}/${repo}/actions/runs?head_sha=${candidateSha}&per_page=100`),
      ]);
      return { statuses, checkRuns: checks.check_runs || [], workflowRuns: workflows.workflow_runs || [] };
    },
    async readLedger(ref, filePath) {
      const value = await api(`/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`, { allow404: true });
      if (!value) return undefined;
      return { ledger: JSON.parse(Buffer.from(value.content, "base64").toString("utf8")), sha: value.sha };
    },
    async writeLedger(ref, filePath, ledger, existingSha) {
      const existingRef = await api(`/repos/${owner}/${repo}/git/ref/heads/${encodeRef(ref)}`, { allow404: true });
      if (!existingRef) {
        const metadata = await api(`/repos/${owner}/${repo}`);
        const base = await api(`/repos/${owner}/${repo}/git/ref/heads/${encodeRef(metadata.default_branch)}`);
        await api(`/repos/${owner}/${repo}/git/refs`, {
          method: "POST",
          body: { ref: `refs/heads/${ref}`, sha: base.object.sha },
        });
      }
      return api(`/repos/${owner}/${repo}/contents/${filePath}`, {
        method: "PUT",
        body: {
          message: "chore(buildchain): update stable candidate ledger",
          content: Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`).toString("base64"),
          branch: ref,
          ...(existingSha ? { sha: existingSha } : {}),
        },
      });
    },
    async ensureBranch(ref, candidateSha) {
      const current = await api(`/repos/${owner}/${repo}/git/ref/heads/${encodeRef(ref)}`, { allow404: true });
      if (!current) {
        return api(`/repos/${owner}/${repo}/git/refs`, { method: "POST", body: { ref: `refs/heads/${ref}`, sha: candidateSha } });
      }
      if (current.object.sha !== candidateSha) {
        throw new Error(`source-lock branch ${ref} already points to ${current.object.sha}, not ${candidateSha}`);
      }
      return current;
    },
    async ensurePromotionPullRequest({ head, base, title, body }) {
      const open = await api(`/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&per_page=20`);
      return open[0] || api(`/repos/${owner}/${repo}/pulls`, { method: "POST", body: { head, base, title, body } });
    },
    async enableAutoMerge(pullRequest) {
      const query = `mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:MERGE}){pullRequest{url}}}`;
      return api("/graphql", { method: "POST", body: { query, variables: { id: pullRequest.node_id } } });
    },
    async setVariable(name, value) {
      const current = await api(`/repos/${owner}/${repo}/actions/variables/${encodeURIComponent(name)}`, { allow404: true });
      if (current) {
        return api(`/repos/${owner}/${repo}/actions/variables/${encodeURIComponent(name)}`, {
          method: "PATCH",
          body: { name, value },
        });
      }
      return api(`/repos/${owner}/${repo}/actions/variables`, { method: "POST", body: { name, value } });
    },
    async deleteVariable(name) {
      const current = await api(`/repos/${owner}/${repo}/actions/variables/${encodeURIComponent(name)}`, { allow404: true });
      if (!current) return undefined;
      return api(`/repos/${owner}/${repo}/actions/variables/${encodeURIComponent(name)}`, { method: "DELETE" });
    },
  };
}

function markdown(result) {
  const selected = result.selection.selected ? result.selection.candidate.version : "none";
  return [
    "## Buildchain stable candidate patrol",
    "",
    `Repository: \`${result.repository}\``,
    `Target: \`${result.targetBranch}\``,
    `Ledger: \`${result.ledgerRef}\``,
    `Selected: \`${selected}\` (${result.selection.reason})`,
    `Dry run: \`${result.dryRun}\``,
    "",
    `Candidates: ${JSON.stringify(result.summary)}`,
    "",
  ].join("\n");
}

async function main() {
  const options = normalizeStableCandidatePatrolOptions();
  const result = await runStableCandidatePatrol(options);
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  const summary = markdown(result);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else process.stdout.write(summary);
  if (process.env.GITHUB_OUTPUT) {
    const lines = {
      "result-path": options.outputPath,
      selected: String(result.selection.selected),
      "selected-version": result.selection.candidate?.version || "",
      "selected-sha": result.selection.candidate?.sha || "",
      "stable-version": result.selection.candidate?.stableVersion || "",
      "promotion-pr": result.promotion?.pullRequest?.html_url || "",
    };
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${Object.entries(lines).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
