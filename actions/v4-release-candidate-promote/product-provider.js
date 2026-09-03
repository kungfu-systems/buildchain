import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateReleaseCandidateRecoveryReceipt } from "../../packages/core/release-candidate-recovery.js";
import {
  compileReleaseTailDeclaration,
  createReleaseTailTransaction,
  executeReleaseTailTransaction,
  readReleaseTailTransaction,
  releaseTailRoot,
  writeReleaseTailTransaction,
} from "../../packages/core/release-tail-provider-plane.js";
import {
  createV4ProductPublicationDeclaration,
  selectV4ProductPublicationIntent,
} from "../../packages/core/v4-product-publication.js";
import {
  createV4ProductPublicationAdapters,
  localVersionFiles,
  resolveCandidateProviderInputs,
  resolvePublicationTarget as resolvePublicationTargetAdapter,
} from "./product-provider-adapters.js";
import { discoverConfiguredDerivedVersionMaterial } from "../../packages/core/buildchain-config.js";
import { createNextDevelopmentTransition } from "../../packages/core/next-development-transition.js";
import { discoverVersionStateFiles } from "../promote-buildchain-ref/internal/version-state.js";
import { commitContainsReleaseState } from "./product-provider-github-adapters.js";

export { resolveCandidateProviderInputs } from "./product-provider-adapters.js";

const NEXT_DEVELOPMENT_POLL_MS = 15_000;
const NEXT_DEVELOPMENT_MAX_POLLS = 480;
const NEXT_DEVELOPMENT_SIGN_OFF =
  "Signed-off-by: Keren Dong <keren.dong@kungfu.link>";

function repositoryParts(repository) {
  const [owner, repo] = String(repository || "").split("/");
  if (!owner || !repo) throw new Error(`invalid repository: ${repository}`);
  return { owner, repo };
}

async function readRef(octokit, repository, ref) {
  const { owner, repo } = repositoryParts(repository);
  try {
    return (
      await octokit.rest.git.getRef({
        owner,
        repo,
        ref: ref.replace(/^refs\//u, ""),
      })
    ).data.object.sha;
  } catch (error) {
    if (Number(error?.status || error?.response?.status) === 404) return "";
    throw error;
  }
}

async function remotePackageVersion(octokit, repository, ref) {
  const { owner, repo } = repositoryParts(repository);
  const { data } = await octokit.rest.repos.getContent({
    owner,
    repo,
    path: "package.json",
    ref,
  });
  return JSON.parse(Buffer.from(data.content, data.encoding).toString())
    .version;
}

export async function advanceAlphaNextDevelopment({
  cwd = process.cwd(),
  repository,
  completedAlpha,
  octokit,
  mutationOctokit,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  pollIntervalMs = NEXT_DEVELOPMENT_POLL_MS,
  maxPolls = NEXT_DEVELOPMENT_MAX_POLLS,
}) {
  const discovered = discoverVersionStateFiles(cwd);
  const sourcePaths = discovered.files.map(({ path: filePath }) => filePath);
  const derivedPaths = discoverConfiguredDerivedVersionMaterial(
    cwd,
    discovered.config,
  ).map(({ path: filePath }) => filePath);
  const transition = createNextDevelopmentTransition({
    repository,
    completedAlpha,
    model: { strategy: "semver", next: "auto" },
    sourcePaths,
    derivedPaths,
  });
  const match = completedAlpha.version.match(/^(\d+)\.(\d+)\./u);
  const devBranch = `dev/v${match[1]}/v${match[1]}.${match[2]}`;
  const devSha = await readRef(octokit, repository, `refs/heads/${devBranch}`);
  if (!devSha) throw new Error(`protected Dev branch ${devBranch} is absent`);
  if (
    (await remotePackageVersion(octokit, repository, devSha)) ===
    transition.target.version
  )
    return { status: "already-current", transition, devSha };
  const { owner, repo } = repositoryParts(repository);
  const devCommit = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: devSha,
  });
  if (devCommit.data.tree.sha !== completedAlpha.treeSha)
    throw new Error(
      "protected Dev tree drifted before next-version materialization",
    );

  const versionFiles = localVersionFiles(cwd, {
    channel: "alpha",
    version: transition.target.version,
    sourceSha: devSha,
    sourceTimestamp: completedAlpha.completedAt,
  });
  const suffix = transition.idempotencyKey
    .replace(/^sha256:/u, "")
    .slice(0, 16);
  const head = `chore/next-development/${transition.target.version}-${suffix}`;
  let headSha = await readRef(octokit, repository, `refs/heads/${head}`);
  if (!headSha) {
    const tree = [];
    for (const file of versionFiles) {
      const blob = await mutationOctokit.rest.git.createBlob({
        owner,
        repo,
        content: file.content,
        encoding: "utf-8",
      });
      tree.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: blob.data.sha,
      });
    }
    const preparedTree = await mutationOctokit.rest.git.createTree({
      owner,
      repo,
      base_tree: devCommit.data.tree.sha,
      tree,
    });
    const commit = await mutationOctokit.rest.git.createCommit({
      owner,
      repo,
      message:
        `chore(release): prepare ${transition.target.version}\n\n` +
        NEXT_DEVELOPMENT_SIGN_OFF,
      tree: preparedTree.data.sha,
      parents: [devSha],
    });
    headSha = commit.data.sha;
    await mutationOctokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${head}`,
      sha: headSha,
    });
  }

  const listed = await mutationOctokit.rest.pulls.list({
    owner,
    repo,
    state: "all",
    base: devBranch,
    head: `${owner}:${head}`,
  });
  let pull = listed.data[0];
  if (!pull)
    pull = (
      await mutationOctokit.rest.pulls.create({
        owner,
        repo,
        head,
        base: devBranch,
        title: `Prepare ${transition.target.version}`,
        body: `Advance protected development to ${transition.target.version} after the completed Alpha publication.`,
      })
    ).data;
  if (pull.state === "closed" && !pull.merged_at)
    throw new Error("next-development pull request was closed without merge");
  if (!pull.merged_at) {
    try {
      await mutationOctokit.graphql(
        `mutation BuildchainEnqueuePullRequest($input: EnqueuePullRequestInput!) {
          enqueuePullRequest(input: $input) { mergeQueueEntry { id } }
        }`,
        { input: { pullRequestId: pull.node_id, expectedHeadOid: headSha } },
      );
    } catch (error) {
      if (!/already.*queue|queue.*already/iu.test(String(error?.message || "")))
        throw error;
    }
  }
  for (let poll = 0; !pull.merged_at && poll <= maxPolls; poll += 1) {
    if (poll > 0) await wait(pollIntervalMs);
    pull = (
      await octokit.rest.pulls.get({ owner, repo, pull_number: pull.number })
    ).data;
  }
  if (!pull.merged_at)
    throw new Error("next-development merge queue timed out");
  const mergedDevSha = await readRef(
    octokit,
    repository,
    `refs/heads/${devBranch}`,
  );
  if (
    !(await commitContainsReleaseState(
      octokit,
      repository,
      headSha,
      mergedDevSha,
    )) ||
    (await remotePackageVersion(octokit, repository, mergedDevSha)) !==
      transition.target.version
  )
    throw new Error("next-development protected Dev readback failed");
  return {
    status: "verified",
    transition,
    devSha: mergedDevSha,
    pullRequest: { number: pull.number, url: pull.html_url },
  };
}

const read = (file) => JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));

export function resolveCandidateBuildSummaryPath({
  candidatePassportPath,
  declaredPath = "",
}) {
  const selected = String(declaredPath || "").trim();
  if (selected) return selected;
  const artifactsRoot = path.resolve(path.dirname(candidatePassportPath), "..");
  const matches = fs
    .readdirSync(artifactsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(artifactsRoot, entry.name, "build-summary.json"))
    .filter((entry) => fs.existsSync(entry))
    .sort();
  if (matches.length !== 1) {
    throw new Error(
      `candidate-build-summary-path is required when the sealed candidate has ${matches.length === 0 ? "no" : "ambiguous"} standard summary artifacts`,
    );
  }
  return matches[0];
}

export function resolvePromotionTarget({
  candidatePassportPath,
  candidate,
  repository,
  channel,
  sourceSha,
  declaredTargetRef = "",
  declaredTargetSha = "",
  expectedTransactionId = "",
}) {
  const sealedBundleRoot = path.resolve(
    path.dirname(candidatePassportPath),
    "../..",
  );
  const recoveryReceiptPath = path.join(
    path.dirname(sealedBundleRoot),
    "recovery-receipt.json",
  );
  const hasRecoveryReceipt = fs.existsSync(recoveryReceiptPath);
  const recoveryReceipt = hasRecoveryReceipt ? read(recoveryReceiptPath) : null;
  const targetRef = String(
    declaredTargetRef || recoveryReceipt?.target?.ref || "",
  ).trim();
  const targetSha = String(
    declaredTargetSha || recoveryReceipt?.target?.sha || "",
  ).trim();
  if (!targetRef || !targetSha)
    throw new Error(
      "target-ref and target-sha are required when no standard recovery receipt supplies them",
    );
  if (!hasRecoveryReceipt) {
    if (expectedTransactionId)
      throw new Error(
        "resume-transaction-id requires a standard recovery receipt",
      );
    if (sourceSha !== targetSha)
      throw new Error(
        "protected source SHA must equal target-sha without recovery evidence",
      );
    return { targetRef, targetSha };
  }
  const validation = validateReleaseCandidateRecoveryReceipt({
    receipt: recoveryReceipt,
    passport: candidate,
    repository,
    targetChannel: channel,
    targetRef,
    targetSha,
    targetTree: candidate.source?.treeHash,
  });
  if (!validation.ok)
    throw new Error(
      `standard recovery receipt is invalid: ${validation.errors.join("; ")}`,
    );
  if (
    expectedTransactionId &&
    recoveryReceipt.transaction?.identity !== expectedTransactionId
  )
    throw new Error("standard recovery receipt transaction identity mismatch");
  if (![targetSha, candidate.source?.headSha].includes(sourceSha))
    throw new Error(
      "legacy source-sha is not bound to the recovered candidate or protected target",
    );
  return { targetRef, targetSha };
}

export async function resolvePublicationTarget(args) {
  return resolvePublicationTargetAdapter(args, resolvePromotionTarget);
}

export function activateExactPnpm({ temporaryRoot = os.tmpdir() } = {}) {
  const shimDirectory = fs.mkdtempSync(
    path.join(temporaryRoot, "buildchain-pnpm-"),
  );
  const shimPath = path.join(shimDirectory, "pnpm");
  fs.writeFileSync(shimPath, '#!/bin/sh\nexec corepack pnpm@11.7.0 "$@"\n', {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(shimDirectory, "pnpm.cmd"),
    "@echo off\r\ncorepack pnpm@11.7.0 %*\r\n",
  );
  process.env.PATH = `${shimDirectory}${path.delimiter}${process.env.PATH || ""}`;
  return shimPath;
}

export function selectProductPublicationPlan(
  result,
  {
    fallbackVersion = "",
    fallbackTag = "",
    fallbackCandidateVersion = "",
  } = {},
) {
  const planned = result?.updates?.find(
    ({ action }) => action === "dry-run-publish-transaction",
  );
  const version = String(planned?.version || fallbackVersion || "").trim();
  const tag = String(
    planned?.publicTag || planned?.tag || fallbackTag || "",
  ).trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version))
    throw new Error(
      "product publication planning did not produce an exact version",
    );
  if (tag !== `v${version}`)
    throw new Error(
      "product publication planning produced a mismatched exact tag",
    );
  const plannedCandidateVersion = String(
    planned?.releaseCandidateVersion || "",
  ).trim();
  const sealedVersion = String(fallbackCandidateVersion || "").trim();
  if (
    plannedCandidateVersion &&
    sealedVersion &&
    plannedCandidateVersion !== sealedVersion
  )
    throw new Error(
      "product publication planning drifted from the sealed candidate version",
    );
  return {
    version,
    tag,
    candidateVersion: plannedCandidateVersion || sealedVersion,
  };
}

export function sealedCandidateVersion(request) {
  const manifest = read(request.sealedBundleManifest);
  const name = String(manifest?.npm?.name || "").trim();
  const version = String(manifest?.npm?.version || "").trim();
  if (name !== request.publishPackageMain || !version)
    throw new Error(
      "sealed candidate manifest omitted the exact main package version",
    );
  return version;
}

function providerProjection({
  transaction,
  targetRef,
  targetSha,
  intent,
  releaseSha,
  updates,
}) {
  const projection = {
    schema: "kungfu.buildchain.v4-product-provider-result/v1",
    target: { ref: targetRef, sha: targetSha },
    publication: {
      version: intent.version,
      exactTag: intent.exactTag,
      releaseSha: String(releaseSha || ""),
      state: transaction.state,
      finalizationNeeded: transaction.state !== "complete",
    },
    promotedSha: String(releaseSha || ""),
    transaction: {
      transactionRoot: transaction.transactionRoot,
      stateRoot: transaction.stateRoot,
      planRoot: transaction.planRoot,
      receiptRoots: transaction.receipts
        .map(({ receiptRoot }) => receiptRoot)
        .sort(),
      failure: transaction.failure,
    },
    updates: (updates || []).map(({ action, ref, tag, sha, version }) => ({
      action: String(action || ""),
      ref: String(ref || ""),
      tag: String(tag || ""),
      sha: String(sha || ""),
      version: String(version || ""),
    })),
  };
  return { ...projection, root: releaseTailRoot(projection) };
}

export async function planProductPublication(
  request,
  { fallbackVersion = "", fallbackTag = "" } = {},
) {
  const supplied = request.publicationIntent;
  if (!supplied)
    throw new Error("rooted product publication intent is required");
  const candidateVersion = sealedCandidateVersion(request);
  if (candidateVersion !== supplied.candidateVersion)
    throw new Error(
      "rooted product publication intent drifted from the sealed candidate version",
    );
  const intent = selectV4ProductPublicationIntent({
    channel: supplied.channel,
    targetRef: supplied.targetRef,
    sourceSha: supplied.sourceSha,
    sourceTimestamp: supplied.sourceTimestamp,
    repository: supplied.repository,
    packageName: supplied.packageName,
    distTag: supplied.distTag,
    sealedBundleRoot: supplied.sealedBundleRoot,
    requiredArtifactsRoot: supplied.requiredArtifactsRoot,
    candidateVersion: supplied.candidateVersion,
    recoveredVersion: supplied.mode === "resume" ? supplied.version : "",
    observedVersions: supplied.observedVersions,
  });
  if (intent.intentRoot !== supplied.intentRoot)
    throw new Error("product publication intent root mismatch");
  if (intent.version !== fallbackVersion || intent.exactTag !== fallbackTag)
    throw new Error("QUALIFY product publication intent drifted before APPLY");
  return {
    version: intent.version,
    tag: intent.exactTag,
    candidateVersion,
    intentRoot: intent.intentRoot,
  };
}

export async function applyProductPublication(request, plan) {
  const declaration = createV4ProductPublicationDeclaration({
    intent: request.publicationIntent,
    plan,
  });
  const effectPlan = compileReleaseTailDeclaration(declaration);
  const statePath = path.resolve(
    ".buildchain/release-tail/product-provider-transaction.json",
  );
  let transaction = fs.existsSync(statePath)
    ? readReleaseTailTransaction(statePath)
    : createReleaseTailTransaction(effectPlan);
  if (
    transaction.transactionRoot !== plan.transactionRoot ||
    transaction.planRoot !== effectPlan.planRoot
  )
    throw new Error(
      "retained product transaction drifted from the rooted plan",
    );
  if (
    ![
      "preparing",
      "prepared",
      "publishing",
      "committing",
      "reading-back",
    ].includes(transaction.state) &&
    transaction.state !== "complete"
  )
    transaction = createReleaseTailTransaction(effectPlan);
  const runtime = createV4ProductPublicationAdapters({
    request,
    intent: request.publicationIntent,
    plan,
  });
  transaction = await executeReleaseTailTransaction(transaction, {
    adapters: runtime.adapters,
    checkpoint: (next) => writeReleaseTailTransaction(statePath, next),
  });
  writeReleaseTailTransaction(statePath, transaction);
  const releaseSha = await runtime.resolveReleaseSha();
  const projection = providerProjection({
    transaction,
    targetRef: request.targetRef,
    targetSha: request.targetSha,
    intent: request.publicationIntent,
    releaseSha,
    updates: runtime.updates,
  });
  if (
    projection.publication.state !== "complete" ||
    projection.publication.finalizationNeeded
  )
    throw Object.assign(
      new Error(
        `product provider stopped in ${projection.publication.state || "unknown"}: finalization-needed=${projection.publication.finalizationNeeded}`,
      ),
      {
        code:
          projection.transaction.failure?.code ||
          "product-publication-finalization-needed",
        providerProjection: projection,
      },
    );
  if (!/^[0-9a-f]{40}$/u.test(projection.publication.releaseSha))
    throw new Error(
      "product provider result omitted the exact public release SHA",
    );
  return projection;
}
