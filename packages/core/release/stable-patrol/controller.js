import {
  createStableCandidateLedger,
  markStableCandidatePromoted,
  qualifyStableCandidate,
  registerStableCandidate,
  revokeStableCandidate,
  selectStableCandidate,
  setStableCandidateHold,
  stableCandidatePromotionRefs,
} from "../stable-candidate-ledger.js";

import {
  text,
  LEDGER_PATH,
  shouldEnableAutoMerge,
  normalizeStableCandidatePatrolOptions,
} from "./options.js";
function targetLinePrefix(branch) {
  const match = branch.match(/^release\/v(\d+)\/v(\d+)\.(\d+)$/);
  return `${match[2]}.${match[3]}.`;
}

function alphaRelease(release, prefix) {
  const version = text(release.tag_name).replace(/^v/, "");
  return release.prerelease === true &&
    version.startsWith(prefix) &&
    /^\d+\.\d+\.\d+-alpha\.\d+$/.test(version)
    ? {
        version,
        publishedAt: release.published_at,
        url: release.html_url,
        actor: release.author?.login || "",
        releasePublished: true,
      }
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
  const [kind, explicitName] = name.includes(":")
    ? name.split(/:(.*)/s, 2)
    : ["", name];
  const expected = explicitName || name;
  if (kind === "workflow") {
    const run = (evidence.workflowRuns || []).find(
      (entry) =>
        entry.name === expected || entry.path?.endsWith(`/${expected}`),
    );
    return {
      id: name,
      status: run?.conclusion === "success" ? "pass" : "fail",
      completedAt: run?.updated_at || "",
      evidenceUrl: run?.html_url || "",
    };
  }
  const status = (evidence.statuses || []).find(
    (entry) => entry.context === expected,
  );
  if (status) {
    return {
      id: name,
      status: status.state === "success" ? "pass" : "fail",
      completedAt: status.updated_at || "",
      evidenceUrl: status.target_url || "",
    };
  }
  const run = (evidence.checkRuns || []).find(
    (entry) =>
      entry.name === expected || (!kind && entry.name?.includes(expected)),
  );
  return {
    id: name,
    status: run?.conclusion === "success" ? "pass" : "fail",
    completedAt: run?.completed_at || "",
    evidenceUrl: run?.html_url || "",
  };
}

async function discoverQualifiedStableCandidates(
  ledger,
  options,
  client,
  releases,
) {
  const prefix = targetLinePrefix(options.targetBranch);
  const releaseDiscoveries = releases
    .map((release) => alphaRelease(release, prefix))
    .filter(Boolean);
  const tagDiscoveries = (await client.listAlphaTags?.(prefix)) || [];
  const discoveryByVersion = new Map(
    tagDiscoveries.map((candidate) => [candidate.version, candidate]),
  );
  for (const release of releaseDiscoveries) {
    discoveryByVersion.set(release.version, {
      ...discoveryByVersion.get(release.version),
      ...release,
    });
  }
  const discoveries = [...discoveryByVersion.values()];
  for (const discovery of discoveries) {
    const candidateSha =
      discovery.sha || (await client.resolveTagSha(`v${discovery.version}`));
    ledger = registerStableCandidate(
      ledger,
      { ...discovery, sha: candidateSha },
      { now: options.now },
    );
    const evidence = await client.getCommitEvidence(candidateSha);
    ledger = qualifyStableCandidate(
      ledger,
      {
        version: discovery.version,
        sha: candidateSha,
        actor: "buildchain-patrol",
        checks: options.requiredChecks.map((name) =>
          checkObservation(
            name,
            {
              ...evidence,
              releaseUrl: discovery.url,
              releasePublished: discovery.releasePublished === true,
            },
            discovery.publishedAt,
          ),
        ),
      },
      { minimumSoakSeconds: options.minimumSoakSeconds, now: options.now },
    );
  }

  return { ledger, discoveries };
}

async function requestStablePromotion(ledger, selection, options, client) {
  let promotion;
  if (selection.selected) {
    const refs = stableCandidatePromotionRefs(
      selection.candidate,
      options.targetBranch,
    );
    promotion = {
      ...refs,
      candidateVersion: selection.candidate.version,
      candidateSha: selection.candidate.sha,
    };
    if (options.autoPromote && !options.dryRun) {
      if (selection.reason === "human-release-now") {
        await client.setVariable?.(
          "BUILDCHAIN_STABLE_RELEASE_NOW",
          selection.candidate.version,
        );
        await client.setVariable?.(
          "BUILDCHAIN_STABLE_RELEASE_REASON",
          `Buildchain Stable Candidate Patrol human release-now for ${selection.candidate.version}`,
        );
      }
      await client.ensureBranch(
        refs.sourceRef,
        selection.candidate.sha,
        refs.targetRef,
      );
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
      if (shouldEnableAutoMerge(options, pullRequest)) {
        await client.enableAutoMerge(pullRequest, options.mergeMethod);
      }
      promotion.pullRequest = pullRequest;
      const storedCandidate = ledger.candidates.find(
        (entry) => entry.version === selection.candidate.version,
      );
      storedCandidate.promotionRequest = {
        stableTag: refs.stableTag,
        sourceRef: refs.sourceRef,
        targetRef: refs.targetRef,
        pullRequestUrl: pullRequest.html_url || pullRequest.url || "",
        requestedAt: options.now,
        authority: selection.authority,
      };
      if (selection.reason === "human-release-now") {
        storedCandidate.decision = {
          reason: "human-release-now",
          actor: "human",
          updatedAt: options.now,
        };
      }
    }
  }

  return promotion;
}

export async function runStableCandidatePatrol(optionsInput = {}, clientInput) {
  const options = normalizeStableCandidatePatrolOptions(optionsInput);
  const client = clientInput;
  if (!client)
    throw new Error(
      "Stable candidate patrol requires an explicit provider client",
    );
  const stored = await client.readLedger(options.ledgerRef, LEDGER_PATH);
  let ledger =
    stored?.ledger ||
    createStableCandidateLedger({
      repository: options.repository,
      targetBranch: options.targetBranch,
      now: options.now,
    });

  const releases = await client.listReleases();
  const discovered = await discoverQualifiedStableCandidates(
    ledger,
    options,
    client,
    releases,
  );
  ledger = discovered.ledger;
  const { discoveries } = discovered;

  for (const version of options.revokedVersions) {
    const candidate = ledger.candidates.find(
      (entry) => entry.version === version.replace(/^v/, ""),
    );
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
    if (
      candidate.state === "promoted" ||
      !candidate.promotionRequest?.stableTag
    )
      continue;
    const stable = releases.find(
      (release) =>
        release.tag_name === candidate.promotionRequest.stableTag &&
        release.prerelease !== true,
    );
    if (!stable) continue;
    ledger = markStableCandidatePromoted(ledger, candidate.version, {
      stableTag: stable.tag_name,
      stableSha: await client.resolveTagSha(stable.tag_name),
      now: stable.published_at || options.now,
    });
    if (!options.dryRun && candidate.promotionRequest?.authority === "human") {
      await client.deleteVariable?.("BUILDCHAIN_STABLE_RELEASE_NOW");
      await client.deleteVariable?.("BUILDCHAIN_STABLE_RELEASE_REASON");
    }
  }

  const publishedStableVersions = releases
    .filter(
      (release) =>
        release.prerelease !== true &&
        /^v\d+\.\d+\.\d+$/.test(text(release.tag_name)),
    )
    .map((release) => ({
      version: text(release.tag_name).replace(/^v/, ""),
      tag: text(release.tag_name),
      publishedAt: release.published_at || "",
      url: release.html_url || "",
    }));
  ledger.stableReleases = publishedStableVersions;
  for (const candidate of ledger.candidates) {
    const stable = publishedStableVersions.find(
      (entry) => entry.version === candidate.stableVersion,
    );
    if (!stable || ["promoted", "revoked"].includes(candidate.state)) continue;
    ledger = revokeStableCandidate(ledger, candidate.version, {
      reason: `stable-version-already-published:${stable.tag}`,
      actor: "buildchain-patrol",
      now: stable.publishedAt || options.now,
    });
  }

  const selection = selectStableCandidate(ledger, {
    releaseNow: options.releaseNow,
    now: options.now,
  });
  const promotion = await requestStablePromotion(
    ledger,
    selection,
    options,
    client,
  );

  if (!options.dryRun) {
    await client.writeLedger(
      options.ledgerRef,
      LEDGER_PATH,
      ledger,
      stored?.sha,
    );
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
      soaking: ledger.candidates.filter((entry) => entry.state === "soaking")
        .length,
      qualified: ledger.candidates.filter(
        (entry) => entry.state === "qualified",
      ).length,
      revoked: ledger.candidates.filter((entry) => entry.state === "revoked")
        .length,
      promoted: ledger.candidates.filter((entry) => entry.state === "promoted")
        .length,
    },
    ledger,
  };
  return result;
}
