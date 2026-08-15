const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const EXACT_SHA = /^[0-9a-f]{40}$/u;
const OFFICIAL_REF = /^v4(?:-alpha)?$/u;
const GOVERNED_REF = /^(?:train|authority)\/v4\/v4\.\d+\/[A-Za-z0-9._/-]+$/u;

function normalizeRef(value) {
  return String(value || "")
    .trim()
    .replace(/^refs\/(?:heads|tags)\//u, "");
}

async function readProviderRef({ github, owner, repo, ref }) {
  let response;
  for (const namespace of ["heads", "tags"]) {
    try {
      response = await github.rest.git.getRef({
        owner,
        repo,
        ref: `${namespace}/${ref}`,
      });
      break;
    } catch (error) {
      if (error?.status !== 404) throw error;
    }
  }
  if (!response) return undefined;
  return {
    ref,
    sha: String(response.data.object.sha || "").toLowerCase(),
    providerRef: response.data.ref || `refs/heads/${ref}`,
  };
}

async function containsCommit({ github, owner, repo, headSha, runtimeSha }) {
  if (headSha === runtimeSha) return true;
  const comparison = await github.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${runtimeSha}...${headSha}`,
  });
  return ["ahead", "identical"].includes(comparison.data.status);
}

function permissionLevel(permission) {
  const declaredLevel = permission.data.permission;
  const userPermissions = permission.data.user?.permissions;
  return (
    (typeof declaredLevel === "string" && declaredLevel) ||
    (typeof userPermissions === "string" && userPermissions) ||
    (userPermissions?.admin && "admin") ||
    (userPermissions?.maintain && "maintain") ||
    (userPermissions?.push && "write") ||
    (userPermissions?.triage && "triage") ||
    (userPermissions?.pull && "read") ||
    "none"
  );
}

async function requireTrustedActor({ github, context }) {
  if (context.eventName !== "workflow_dispatch") {
    throw new Error(
      "promotion runtime override is only allowed for trusted workflow_dispatch runs",
    );
  }
  const permission = await github.rest.repos.getCollaboratorPermissionLevel({
    owner: context.repo.owner,
    repo: context.repo.repo,
    username: context.actor,
  });
  const level = permissionLevel(permission);
  if (!["write", "maintain", "admin"].includes(level)) {
    throw new Error(
      `promotion runtime override requires write, maintain, or admin permission; actor has ${level}`,
    );
  }
  return { actor: context.actor, permission: level };
}

function normalizeRequestedSelection(request) {
  const requestedRef = normalizeRef(request.requestedRef);
  const runtimeSha = String(request.resolvedRuntimeSha || "")
    .trim()
    .toLowerCase();
  if (!EXACT_SHA.test(runtimeSha)) {
    throw new Error("resolved runtime must be an exact 40-character Git SHA");
  }
  if (
    !EXACT_SHA.test(requestedRef.toLowerCase()) &&
    !OFFICIAL_REF.test(requestedRef) &&
    !GOVERNED_REF.test(requestedRef)
  ) {
    throw new Error(
      "requested runtime ref is outside the v4 authority boundary",
    );
  }
  return { requestedRef, runtimeSha };
}

function normalizeRuntimeRepository(request, context) {
  const repository = String(
    request.runtimeRepository || `${context.repo.owner}/${context.repo.repo}`,
  ).split("/");
  if (
    repository.length !== 2 ||
    repository.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part))
  ) {
    throw new Error("runtimeRepository must be owner/repository");
  }
  return { owner: repository[0], repo: repository[1] };
}

async function approvedRuntimeRefReadbacks({
  github,
  runtime,
  runtimeRepository,
  requestedRef,
  runtimeSha,
}) {
  const refs = new Set(["v4", "v4-alpha"]);
  if (GOVERNED_REF.test(requestedRef)) refs.add(requestedRef);
  const approvedRefReadbacks = [];
  for (const ref of [...refs].sort()) {
    const readback = await readProviderRef({
      github,
      ...runtimeRepository,
      ref,
    });
    if (!readback) continue;
    const containsRuntimeSha = await containsCommit({
      github,
      ...runtimeRepository,
      headSha: readback.sha,
      runtimeSha,
    });
    approvedRefReadbacks.push({
      ref,
      sha: readback.sha,
      containsRuntimeSha,
      readbackRoot: runtime.v4RuntimeResumeDocumentRoot({
        provider: "github",
        repository: `${runtimeRepository.owner}/${runtimeRepository.repo}`,
        providerRef: readback.providerRef,
        sha: readback.sha,
        runtimeSha,
        containsRuntimeSha,
      }),
    });
  }
  return approvedRefReadbacks;
}

function writeAuthorization(outputPath, authorization) {
  if (!outputPath) return;
  const output = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(authorization, null, 2)}\n`);
}

async function authorizePromotionRuntimeOverride({
  github,
  context,
  request = undefined,
}) {
  const actor = await requireTrustedActor({ github, context });
  if (!request) return actor;

  const { requestedRef, runtimeSha } = normalizeRequestedSelection(request);
  const consumerRoot = path.resolve(request.consumerRoot || process.cwd());
  const runtimeModulePath = path.resolve(
    request.runtimeModulePath ||
      path.join(
        process.cwd(),
        ".buildchain/router/packages/core/v4-runtime-ref-resume-authority.js",
      ),
  );
  const runtime = await import(pathToFileURL(runtimeModulePath).href);
  const policyDocument = JSON.parse(
    fs.readFileSync(path.resolve(request.consumerPolicyReceiptPath), "utf8"),
  );
  const policyReceipt = policyDocument.receipt || policyDocument;
  const persistenceScan = runtime.scanV4RuntimeSelectorPersistence({
    root: consumerRoot,
  });
  if (persistenceScan.status !== "passed") {
    throw new Error(
      "runtime selector persistence scan rejected the consumer source",
    );
  }

  const runtimeRepository = normalizeRuntimeRepository(request, context);
  const approvedRefReadbacks = await approvedRuntimeRefReadbacks({
    github,
    runtime,
    runtimeRepository,
    requestedRef,
    runtimeSha,
  });
  const sourceTreeSha = String(
    request.sourceTreeSha ||
      execFileSync("git", ["-C", consumerRoot, "rev-parse", "HEAD^{tree}"], {
        encoding: "utf8",
      }),
  )
    .trim()
    .toLowerCase();
  const authorization = runtime.authorizeV4RuntimeSelection({
    repository: `${context.repo.owner}/${context.repo.repo}`,
    eventName: context.eventName,
    mode: request.mode || "dispatch",
    actor: context.actor,
    actorPermission: actor.permission,
    reason: request.reason,
    authorizedAt: request.authorizedAt || new Date().toISOString(),
    sourceSha: request.sourceSha || context.sha,
    sourceTreeSha,
    requestedRef,
    resolvedRuntimeSha: runtimeSha,
    approvedRefReadbacks,
    stableContractLockRoot: policyReceipt.contractLocks?.stable?.root,
    alphaContractLockRoot: policyReceipt.contractLocks?.alpha?.root,
    consumerPolicyReceiptRoot:
      request.consumerPolicyReceiptRoot || policyDocument.receiptRoot,
    persistenceScan,
  });
  writeAuthorization(request.outputPath, authorization);
  return { ...actor, ...authorization, persistenceScan };
}

module.exports = { authorizePromotionRuntimeOverride };
