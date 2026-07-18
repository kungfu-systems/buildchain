import crypto from "node:crypto";

import actionContract from "./kfd7-buildchain-action-contract.json" with { type: "json" };
import {
  PUBLICATION_ADMISSION_CONTRACT,
  publicationAuthorityDigest,
} from "./publication-authority.js";
import {
  RELEASE_CANDIDATE_PASSPORT_CONTRACT,
  sha256Json,
  validateReleaseCandidatePassport,
} from "./release-candidate.js";
import { releaseTransactionId } from "./publish-transaction.js";

export const BUILDCHAIN_KFD7_PROFILE_SCHEMA =
  "buildchain.kfd7.release-profile/v1";
export const BUILDCHAIN_KFD7_PROFILE_ID =
  "buildchain-release-transaction-profile";
export const BUILDCHAIN_KFD7_SESSION_SCHEMA =
  "buildchain.kfd7.release-session/v1";
export const BUILDCHAIN_KFD7_SESSION_EXPANSION_SCHEMA =
  "buildchain.kfd7.release-session-expansion/v1";
export const BUILDCHAIN_KFD7_SESSION_COMPRESSIBILITY_SCHEMA =
  "buildchain.kfd7.release-session-compressibility/v1";
export const BUILDCHAIN_KFD7_ROLES = Object.freeze([
  "fact",
  "episode",
  "pursuit",
  "atlas",
  "warrant",
]);
export const BUILDCHAIN_KFD7_ACTION_CONTRACT = actionContract;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function roleState(
  transaction,
  candidatePassport,
  publicationAdmission,
  observedAt,
) {
  const observed = new Date(observedAt).getTime();
  const expires = new Date(publicationAdmission.expiresAt).getTime();
  const terminal = new Set(["complete", "abandoned", "failed_permanently"]);
  const atlasCurrent =
    candidatePassport.source?.headSha === transaction.source_sha &&
    candidatePassport.target?.version === transaction.version;
  return {
    fact: transaction.state === "complete" ? "superseded" : "declared",
    episode: terminal.has(transaction.state) ? "sealed" : "open",
    pursuit:
      transaction.state === "complete"
        ? "completed"
        : transaction.state === "abandoned"
          ? "abandoned"
          : "active",
    atlas: atlasCurrent ? "current" : "stale",
    warrant:
      Number.isFinite(expires) && expires > observed ? "issued" : "expired",
  };
}

function validateAdmission(admission) {
  const errors = [];
  if (admission?.contract !== PUBLICATION_ADMISSION_CONTRACT) {
    errors.push("publication-admission-contract-mismatch");
    return errors;
  }
  const { admissionDigest, ...payload } = admission;
  if (
    publicationAuthorityDigest(payload) !==
    String(admissionDigest || "").replace(/^sha256:/, "")
  ) {
    errors.push("publication-admission-digest-mismatch");
  }
  return errors;
}

export function validateBuildchainKfd7ProfileSnapshot(snapshot) {
  const errors = [];
  if (snapshot?.schema !== BUILDCHAIN_KFD7_PROFILE_SCHEMA)
    errors.push("profile-schema-mismatch");
  if (snapshot?.profileId !== BUILDCHAIN_KFD7_PROFILE_ID)
    errors.push("profile-id-mismatch");
  const roles = snapshot?.roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) {
    return { ok: false, errors: [...errors, "roles-missing"] };
  }
  if (
    Object.keys(roles).sort().join(",") !==
    [...BUILDCHAIN_KFD7_ROLES].sort().join(",")
  ) {
    errors.push("role-closure-mismatch");
  }
  const identities = [];
  for (const role of BUILDCHAIN_KFD7_ROLES) {
    const value = roles[role];
    if (!value || value.role !== role) {
      errors.push(`${role}-role-mismatch`);
      continue;
    }
    identities.push(value.identity);
    const { root, ...rootInput } = value;
    if (digest(rootInput) !== root) errors.push(`${role}-root-mismatch`);
  }
  if (identities.length !== new Set(identities).size)
    errors.push("role-identity-fusion");
  return { ok: errors.length === 0, errors };
}

export function createBuildchainKfd7ProfileSnapshot({
  transaction,
  candidatePassport,
  publicationAdmission,
  observedAt,
} = {}) {
  const issues = [];
  if (!transaction || typeof transaction !== "object")
    issues.push("release-transaction-missing");
  if (candidatePassport?.contract !== RELEASE_CANDIDATE_PASSPORT_CONTRACT) {
    issues.push("release-candidate-contract-mismatch");
  }
  if (
    transaction &&
    candidatePassport?.contract === RELEASE_CANDIDATE_PASSPORT_CONTRACT
  ) {
    const validation = validateReleaseCandidatePassport({
      passport: candidatePassport,
      repository: transaction.repository,
      version: transaction.version,
      sourceHeadSha: transaction.source_sha,
      requirePlatforms: false,
    });
    issues.push(
      ...validation.errors.map((error) => `release-candidate:${error}`),
    );
    const expectedTransactionId = releaseTransactionId({
      repository: transaction.repository,
      version: transaction.version,
      sourceSha: transaction.source_sha,
      targetRef: transaction.target_ref,
    });
    if (transaction.id !== expectedTransactionId)
      issues.push("release-transaction-id-mismatch");
    const candidateHashInput = {
      repository: candidatePassport.repository,
      target: candidatePassport.target,
      source: candidatePassport.source,
      platformMatrix: candidatePassport.platformMatrix,
      buildchain: candidatePassport.buildchain,
      ...(candidatePassport.gateProfileEvidence
        ? { gateProfileEvidence: candidatePassport.gateProfileEvidence }
        : {}),
      ...(candidatePassport.controllerReceipts
        ? { controllerReceipts: candidatePassport.controllerReceipts }
        : {}),
    };
    if (candidatePassport.candidateHash !== sha256Json(candidateHashInput)) {
      issues.push("release-candidate-hash-mismatch");
    }
    if (!candidatePassport.gateProfileEvidence) {
      issues.push("release-candidate:gate-profile-evidence-required");
    }
  }
  issues.push(...validateAdmission(publicationAdmission));
  const observed = new Date(observedAt || "");
  if (Number.isNaN(observed.getTime())) issues.push("observed-at-invalid");
  if (transaction && publicationAdmission) {
    if (publicationAdmission.repository !== transaction.repository)
      issues.push("warrant-repository-mismatch");
    if (publicationAdmission.sourceSha !== transaction.source_sha)
      issues.push("warrant-source-mismatch");
    if (publicationAdmission.version !== transaction.version)
      issues.push("warrant-version-mismatch");
    if (publicationAdmission.channel !== transaction.channel)
      issues.push("warrant-channel-mismatch");
  }
  if (issues.length > 0) {
    return {
      schema: BUILDCHAIN_KFD7_PROFILE_SCHEMA,
      profileId: BUILDCHAIN_KFD7_PROFILE_ID,
      status: "denied",
      failureCode: issues[0],
      issues,
      roles: {},
      writeOccurred: false,
    };
  }

  const states = roleState(
    transaction,
    candidatePassport,
    publicationAdmission,
    observed.toISOString(),
  );
  const roleInputs = {
    fact: {
      sourceHeadSha: candidatePassport.source.headSha,
      sourceTreeHash: candidatePassport.source.treeHash,
      candidateHash: candidatePassport.candidateHash,
    },
    episode: {
      transactionId: transaction.id,
      state: transaction.state,
      previousState: transaction.previous_state,
      evidenceRoots: [...(transaction.evidence || [])]
        .map((value) => digest(value))
        .sort(),
    },
    pursuit: {
      repository: transaction.repository,
      version: transaction.version,
      targetRef: transaction.target_ref,
      exactTag: transaction.exact_tag,
    },
    atlas: {
      candidateContract: candidatePassport.contract,
      candidateHash: candidatePassport.candidateHash,
      buildSummaryHash: candidatePassport.diagnostics?.buildSummaryHash || "",
      gateProfileDigest: candidatePassport.gateProfileEvidence?.digest || "",
    },
    warrant: {
      contract: publicationAdmission.contract,
      admissionDigest: publicationAdmission.admissionDigest,
      environment: publicationAdmission.environment,
      nonce: publicationAdmission.nonce,
      issuedAt: publicationAdmission.issuedAt,
      expiresAt: publicationAdmission.expiresAt,
      sourceSha: publicationAdmission.sourceSha,
    },
  };
  const roles = Object.fromEntries(
    BUILDCHAIN_KFD7_ROLES.map((role) => {
      const rootInput = {
        role,
        identity: `buildchain:${role}:${digest(roleInputs[role]).slice(7, 39)}`,
        state: states[role],
        authority: roleInputs[role],
      };
      return [role, { ...rootInput, root: digest(rootInput) }];
    }),
  );
  const snapshot = {
    schema: BUILDCHAIN_KFD7_PROFILE_SCHEMA,
    profileId: BUILDCHAIN_KFD7_PROFILE_ID,
    profileVersion: "0.1.0",
    status:
      states.atlas === "current" && states.warrant === "issued"
        ? "current"
        : "degraded",
    source: {
      transactionId: transaction.id,
      candidateHash: candidatePassport.candidateHash,
      admissionDigest: publicationAdmission.admissionDigest,
      observedAt: observed.toISOString(),
    },
    roles,
    roleOrder: [...BUILDCHAIN_KFD7_ROLES],
    nonClaims: [
      "This projection does not own release transaction, passport, or publication authority state.",
      "A current snapshot does not prove that publication occurred or that KFD-7 is universally minimal.",
    ],
  };
  const validation = validateBuildchainKfd7ProfileSnapshot(snapshot);
  if (!validation.ok)
    throw new Error(
      `invalid Buildchain KFD-7 snapshot: ${validation.errors.join(", ")}`,
    );
  return {
    ...snapshot,
    snapshotRoot: digest(snapshot),
    candidateDigest: `sha256:${sha256Json(candidatePassport)}`,
  };
}

function validateSessionComponent(session, field, identityField) {
  const component = session?.[field];
  if (!component || typeof component !== "object" || Array.isArray(component))
    throw new Error(`${field}-missing`);
  if (!String(component[identityField] || "").trim())
    throw new Error(`${field}-${identityField}-missing`);
  return component;
}

function validateReleaseSession(session) {
  if (session?.schema !== BUILDCHAIN_KFD7_SESSION_SCHEMA)
    throw new Error("release-session-schema-mismatch");
  if (!String(session.sessionId || "").trim())
    throw new Error("release-session-id-missing");
  const components = {
    pursuit: validateSessionComponent(session, "goal", "pursuitId"),
    atlas: validateSessionComponent(session, "context", "atlasId"),
    warrant: validateSessionComponent(session, "permissions", "warrantId"),
    episode: validateSessionComponent(session, "run", "episodeId"),
    fact: validateSessionComponent(session, "facts", "factId"),
  };
  const identities = [
    components.fact.factId,
    components.episode.episodeId,
    components.pursuit.pursuitId,
    components.atlas.atlasId,
    components.warrant.warrantId,
  ];
  if (new Set(identities).size !== identities.length)
    throw new Error("release-session-role-identity-fusion");
  for (const [field, value] of [
    ["goal.operations", components.pursuit.operations],
    ["permissions.allowedOperations", components.warrant.allowedOperations],
  ]) {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((item) => !String(item || "").trim())
    )
      throw new Error(`${field}-invalid`);
  }
  return components;
}

export function createBuildchainKfd7ReleaseSession(input = {}) {
  const snapshot = createBuildchainKfd7ProfileSnapshot(input);
  if (snapshot.status === "denied") return snapshot;
  const { transaction, candidatePassport, publicationAdmission, observedAt } =
    input;
  const session = {
    schema: BUILDCHAIN_KFD7_SESSION_SCHEMA,
    sessionId: `release-session:${transaction.id}`,
    goal: {
      pursuitId: snapshot.roles.pursuit.identity,
      ...snapshot.roles.pursuit.authority,
      state: snapshot.roles.pursuit.state,
      operations: ["publish-release"],
      alternatives: [],
    },
    context: {
      atlasId: snapshot.roles.atlas.identity,
      ...snapshot.roles.atlas.authority,
      state: snapshot.roles.atlas.state,
      observedAt,
      views: [candidatePassport.candidateHash],
    },
    permissions: {
      warrantId: snapshot.roles.warrant.identity,
      ...snapshot.roles.warrant.authority,
      state: snapshot.roles.warrant.state,
      allowedOperations: ["publish-release"],
      admissions: [publicationAdmission.admissionDigest],
      delegated: false,
    },
    run: {
      episodeId: snapshot.roles.episode.identity,
      ...snapshot.roles.episode.authority,
      state: snapshot.roles.episode.state,
      transactionIds: [transaction.id],
    },
    facts: {
      factId: snapshot.roles.fact.identity,
      ...snapshot.roles.fact.authority,
      state: snapshot.roles.fact.state,
      candidateHashes: [candidatePassport.candidateHash],
      branchRoots: [],
    },
  };
  validateReleaseSession(session);
  return session;
}

export function buildchainKfd7SessionCompressibility(session) {
  const components = validateReleaseSession(session);
  const breakpoints = [];
  if (
    components.pursuit.state !== "active" ||
    components.pursuit.alternatives?.length
  )
    breakpoints.push({
      role: "pursuit",
      code: "multiple-or-terminal-release-intent",
    });
  if (
    components.atlas.state !== "current" ||
    components.atlas.views?.length !== 1
  )
    breakpoints.push({ role: "atlas", code: "candidate-view-boundary" });
  if (
    components.warrant.state !== "issued" ||
    components.warrant.admissions?.length !== 1 ||
    components.warrant.delegated === true
  )
    breakpoints.push({ role: "warrant", code: "publication-authority-boundary" });
  if (components.episode.transactionIds?.length !== 1)
    breakpoints.push({ role: "episode", code: "release-transaction-branch" });
  if (
    components.fact.candidateHashes?.length !== 1 ||
    components.fact.branchRoots?.length
  )
    breakpoints.push({ role: "fact", code: "release-candidate-branch" });
  return {
    schema: BUILDCHAIN_KFD7_SESSION_COMPRESSIBILITY_SCHEMA,
    sessionId: session.sessionId,
    compressible: breakpoints.length === 0,
    breakpoints,
    revealedRoles: [...new Set(breakpoints.map((entry) => entry.role))].sort(),
  };
}

export function buildchainKfd7SessionValidActions(session) {
  const components = validateReleaseSession(session);
  if (
    components.pursuit.state !== "active" ||
    components.atlas.state !== "current" ||
    components.warrant.state !== "issued"
  )
    return [];
  return [...new Set(components.pursuit.operations)].filter((operation) =>
    components.warrant.allowedOperations.includes(operation),
  ).sort();
}

export function expandBuildchainKfd7ReleaseSession(session) {
  const components = validateReleaseSession(session);
  const roles = Object.fromEntries(
    BUILDCHAIN_KFD7_ROLES.map((role) => [
      role,
      {
        role,
        state: components[role].state,
        identity:
          components[role][
            {
              fact: "factId",
              episode: "episodeId",
              pursuit: "pursuitId",
              atlas: "atlasId",
              warrant: "warrantId",
            }[role]
          ],
        details: structuredClone(components[role]),
      },
    ]),
  );
  return {
    schema: BUILDCHAIN_KFD7_SESSION_EXPANSION_SCHEMA,
    sessionId: session.sessionId,
    compressibility: buildchainKfd7SessionCompressibility(session),
    roles,
    observations: {
      direction: roles.pursuit.details,
      "perspective-boundary": roles.atlas.details,
      "effective-authority": roles.warrant.details,
      "causal-process": roles.episode.details,
      "admitted-result": roles.fact.details,
    },
    validActions: buildchainKfd7SessionValidActions(session),
  };
}

export function projectBuildchainKfd7ReleaseSession(expansion) {
  if (expansion?.schema !== BUILDCHAIN_KFD7_SESSION_EXPANSION_SCHEMA)
    throw new Error("release-session-expansion-schema-mismatch");
  if (expansion.compressibility?.compressible !== true)
    throw new Error("session-complexity-breakpoint");
  const roles = expansion.roles;
  if (
    !roles ||
    Object.keys(roles).sort().join(",") !==
      [...BUILDCHAIN_KFD7_ROLES].sort().join(",")
  )
    throw new Error("release-session-role-closure-mismatch");
  const session = {
    schema: BUILDCHAIN_KFD7_SESSION_SCHEMA,
    sessionId: expansion.sessionId,
    goal: structuredClone(roles.pursuit.details),
    context: structuredClone(roles.atlas.details),
    permissions: structuredClone(roles.warrant.details),
    run: structuredClone(roles.episode.details),
    facts: structuredClone(roles.fact.details),
  };
  validateReleaseSession(session);
  return session;
}
