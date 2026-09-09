import path from "node:path";
import { PAPER_PATHS, resolvePaperRepository } from "../paper-repository.js";
import {
  collectPaperGovernanceFacts,
  collectPaperEvidenceFacts,
  state,
  bootstrapSatisfied,
  trustSatisfied,
} from "./status-facts.js";
import { existingFileFact } from "./files.js";
import { PAPER_STATUS_CONTRACT } from "./identity.js";
export function paperStatusBlockingNextActions({
  stateMap,
  deterministic,
  transactionFacts,
}) {
  const actions = [];
  if (!stateMap.scaffolded.satisfied) {
    actions.push({
      id: "scaffold-paper",
      command: "buildchain paper scaffold --help",
      description: "Plan a no-overwrite Buildchain paper scaffold.",
    });
  } else if (!stateMap.governed.satisfied) {
    actions.push({
      id: "restore-governance",
      command: "buildchain paper preflight --json",
      description:
        "Repair the Git/contract-lock governance checks reported by preflight.",
    });
  } else if (!stateMap["content-ready"].satisfied) {
    actions.push({
      id: "complete-paper-content",
      command: "make check",
      description: "Add every declared paper source and metadata input.",
    });
  } else if (!deterministic) {
    actions.push({
      id: "build-reproducible-artifact",
      command: "buildchain paper build --execute --json",
      description:
        "Run the existing two-clean-build reproducibility gate and promote exact bytes.",
    });
  } else if (
    !stateMap.bootstrapped.satisfied ||
    !stateMap["trust-bound"].satisfied
  ) {
    actions.push({
      id: "bootstrap-npm",
      command: "buildchain paper bootstrap npm --json",
      description:
        "Inspect the dry-run npm bootstrap and Trusted Publishing handoff.",
    });
  } else if (!stateMap["alpha-complete"].satisfied) {
    actions.push({
      id: transactionFacts.selected ? "resume-alpha" : "start-alpha",
      command: transactionFacts.selected
        ? "buildchain paper resume --json"
        : "buildchain paper alpha --json",
      description: transactionFacts.selected
        ? "Resume the exact sealed release transaction."
        : "Plan the protected dev-to-alpha publication PR.",
    });
  }
  return actions;
}
export function collectPaperStatus({ cwd = process.cwd() } = {}) {
  const resolvedCwd = path.resolve(cwd);
  const governance = collectPaperGovernanceFacts(resolvedCwd);
  const evidence = collectPaperEvidenceFacts(
    resolvedCwd,
    governance.publication,
    governance.version,
  );
  const {
    configResult,
    loaded,
    publication,
    packageName,
    version,
    configFact,
    scaffoldFacts,
    contractLockError,
    scaffoldOk,
    governedOk,
  } = governance;
  const {
    admitted,
    bootstrapValue,
    trustValue,
    content,
    reproducibility,
    deterministic,
    sealedOk,
    sealedError,
    candidates,
    transactionFacts,
    packagePublished,
    alphaComplete,
    stagingVisible,
    productionVisible,
  } = evidence;

  const states = paperStatusStates({
    admitted,
    alphaComplete,
    bootstrapValue,
    configFact,
    configResult,
    content,
    contractLockError,
    deterministic,
    governedOk,
    packagePublished,
    productionVisible,
    publication,
    resolvedCwd,
    scaffoldFacts,
    scaffoldOk,
    sealedError,
    sealedOk,
    stagingVisible,
    transactionFacts,
    trustValue,
  });
  const achieved = states
    .filter((entry) => entry.satisfied)
    .map((entry) => entry.id);
  const highestEvidenceState =
    [...states].reverse().find((entry) => entry.satisfied)?.id || "none";
  const stateMap = Object.fromEntries(states.map((entry) => [entry.id, entry]));
  const blockingNextActions = paperStatusBlockingNextActions({
    stateMap,
    deterministic,
    transactionFacts,
  });
  return {
    schemaVersion: 1,
    contract: PAPER_STATUS_CONTRACT,
    ok: !configResult.error,
    cwd: resolvedCwd,
    identity: {
      project: loaded?.config?.project?.name || "",
      package: packageName,
      version,
      repository: resolvePaperRepository(resolvedCwd),
    },
    states,
    achieved,
    highestEvidenceState,
    deterministicBuild: {
      status: deterministic
        ? "qualifying"
        : reproducibility.exists
          ? "non-qualifying"
          : "not-run",
      receiptPath: PAPER_PATHS.reproducibilityReceipt,
      receiptDigest: reproducibility.value?.receiptDigest || "",
    },
    transaction: transactionFacts.selected
      ? {
          path: transactionFacts.selected.path,
          id: transactionFacts.selected.transaction.id || "",
          state: transactionFacts.selected.transaction.state || "",
          publicationState: transactionFacts.publicationState,
          targetRef: transactionFacts.selected.transaction.target_ref || "",
          sourceSha: transactionFacts.selected.transaction.source_sha || "",
          resumeCommand:
            transactionFacts.selected.transaction.resume_command || "",
        }
      : null,
    conflicts: [
      ...candidates
        .filter((entry) => entry.error)
        .map((entry) => ({
          code: "release-state-invalid",
          path: entry.path,
          message: entry.error,
        })),
      ...(transactionFacts.matching.length > 1
        ? [
            {
              code: "multiple-release-transactions-for-version",
              paths: transactionFacts.matching.map((entry) => entry.path),
              message:
                "More than one release transaction claims the configured publication version.",
            },
          ]
        : []),
    ],
    blockingNextActions,
    nonClaims: [
      "npm package existence is not inferred without a typed receipt or live preflight observation",
      "publication admission is not inferred from reproducibility",
      "package publication is not inferred from a local npm package directory",
      "staging and production visibility are never inferred from alpha completion",
    ],
  };
}

function paperStatusStates({
  admitted,
  alphaComplete,
  bootstrapValue,
  configFact,
  configResult,
  content,
  contractLockError,
  deterministic,
  governedOk,
  packagePublished,
  productionVisible,
  publication,
  resolvedCwd,
  scaffoldFacts,
  scaffoldOk,
  sealedError,
  sealedOk,
  stagingVisible,
  transactionFacts,
  trustValue,
}) {
  return [
    ...paperAdmissionStates({
      admitted,
      bootstrapValue,
      configFact,
      configResult,
      contractLockError,
      governedOk,
      resolvedCwd,
      scaffoldFacts,
      scaffoldOk,
      trustValue,
    }),
    state(
      "content-ready",
      content.ok ? "satisfied" : publication ? "blocked" : "not-reached",
      content.ok
        ? "Every declared source and metadata input exists."
        : `Declared content is missing: ${content.missing.join(", ") || "publication config unavailable"}.`,
      content.required.map((entry) => existingFileFact(resolvedCwd, entry)),
    ),
    state(
      "artifact-sealed",
      deterministic && sealedOk ? "satisfied" : "not-reached",
      deterministic && sealedOk
        ? "A qualifying reproducibility receipt and verified sealed bundle bind exact artifact bytes."
        : sealedError ||
            "Artifact sealing requires both qualifying reproducibility and an exact sealed bundle; neither is inferred.",
      [
        existingFileFact(resolvedCwd, PAPER_PATHS.reproducibilityReceipt),
        existingFileFact(resolvedCwd, PAPER_PATHS.sealedBundle),
      ],
    ),
    state(
      "package-published",
      packagePublished ? "satisfied" : "not-reached",
      packagePublished
        ? `Release transaction explicitly reports ${transactionFacts.publicationState}.`
        : "No release transaction explicitly proves package publication.",
      transactionFacts.selected
        ? [existingFileFact(resolvedCwd, transactionFacts.selected.path)]
        : [],
    ),
    state(
      "alpha-complete",
      alphaComplete ? "satisfied" : "not-reached",
      alphaComplete
        ? "The alpha release transaction is complete."
        : "No completed alpha transaction is present.",
      transactionFacts.selected
        ? [existingFileFact(resolvedCwd, transactionFacts.selected.path)]
        : [],
    ),
    state(
      "staging-visible",
      stagingVisible ? "satisfied" : "not-reached",
      stagingVisible
        ? "Explicit digest-bound staging visibility evidence is present."
        : "No explicit staging visibility evidence is present; visibility is not inferred from publication.",
      [existingFileFact(resolvedCwd, PAPER_PATHS.visibility)],
    ),
    state(
      "production-visible",
      productionVisible ? "satisfied" : "not-reached",
      productionVisible
        ? "Explicit digest-bound production visibility evidence is present."
        : "No explicit production visibility evidence is present; visibility is not inferred from staging.",
      [existingFileFact(resolvedCwd, PAPER_PATHS.visibility)],
    ),
  ];
}

function paperAdmissionStates({
  admitted,
  bootstrapValue,
  configFact,
  configResult,
  contractLockError,
  governedOk,
  resolvedCwd,
  scaffoldFacts,
  scaffoldOk,
  trustValue,
}) {
  return [
    state(
      "scaffolded",
      scaffoldOk ? "satisfied" : configFact ? "blocked" : "not-reached",
      scaffoldOk
        ? "The complete managed paper scaffold inventory is present."
        : configResult.error || "Paper scaffold is incomplete.",
      scaffoldFacts,
    ),
    state(
      "governed",
      governedOk ? "satisfied" : scaffoldOk ? "blocked" : "not-reached",
      governedOk
        ? "The repository is Git-governed and carries a valid Buildchain contract lock."
        : contractLockError ||
            "Git governance or the Buildchain contract lock is missing.",
      [existingFileFact(resolvedCwd, PAPER_PATHS.contractLock)],
    ),
    state(
      "admitted",
      admitted ? "satisfied" : "not-reached",
      admitted
        ? "Explicit publication admission/capability evidence is present."
        : "No explicit publication admission evidence is present; no admission is inferred.",
      admitted ? [existingFileFact(resolvedCwd, admitted.relativePath)] : [],
    ),
    state(
      "bootstrapped",
      bootstrapSatisfied(bootstrapValue) ? "satisfied" : "not-reached",
      bootstrapSatisfied(bootstrapValue)
        ? "A typed npm package bootstrap receipt exists."
        : "No typed npm bootstrap receipt proves that the public package exists.",
      [existingFileFact(resolvedCwd, PAPER_PATHS.npmBootstrap)],
    ),
    state(
      "trust-bound",
      trustSatisfied(trustValue) ? "satisfied" : "not-reached",
      trustSatisfied(trustValue)
        ? "A typed receipt proves npm Trusted Publishing is configured."
        : "No typed receipt proves the npm Trusted Publisher binding.",
      [
        existingFileFact(resolvedCwd, PAPER_PATHS.npmTrust),
        existingFileFact(resolvedCwd, PAPER_PATHS.npmBootstrap),
      ],
    ),
  ];
}
