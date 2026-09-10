import path from "node:path";
import {
  paperConfig,
  gitValue,
  gitResult,
  PAPER_PATHS,
} from "./paper-repository.js";
import { validateBuildchainConfig } from "../consumer/buildchain-config.js";
import {
  selectPaperRuntime,
  paperRuntimeLockPath,
} from "./paper-runtime-channels.js";
import {
  readBuildchainContractLock,
  evaluateBuildchainContractLock,
} from "../contracts/buildchain-contract.js";
import { collectPaperAgentEntry } from "./paper-agent-entry.js";
import {
  NPM_REGISTRY,
  PAPER_PREFLIGHT_CONTRACT,
} from "./operations/identity.js";
import { collectPaperStatus } from "./operations/status.js";
import {
  validatePaperProvisioningAuthority,
  expectedPaperTrustedPublisher,
} from "./operations/provisioning-validation.js";
import { runtimeFacts } from "./operations/runtime-observation.js";
import { runtimeContractWorld } from "./operations/runtime.js";
import {
  liveNpmPackageObservation,
  liveNpmAuthObservation,
  liveNpmTrustObservation,
} from "./operations/npm-observation.js";
import {
  liveRepositoryPermissionObservation,
  liveRepositoryActionsPolicyObservation,
  liveGeneratedWriteAuthorityObservation,
} from "./operations/github-observation.js";
import { localToolchainObservation } from "./operations/toolchain-observation.js";
import {
  paperPreflightLocalChecks,
  paperPreflightRepositoryChecks,
  paperPreflightPublicationChecks,
  paperPreflightNextActions,
} from "./operations/preflight-checks.js";
export function collectPaperPreflight({
  cwd = process.cwd(),
  buildchainRoot = process.cwd(),
  buildchainVersion = "",
  buildchainRef = "v4",
  buildchainSha = "",
  registry = NPM_REGISTRY,
  offline = false,
  agentEntryMode = "contract",
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const status = collectPaperStatus({ cwd: resolvedCwd });
  const provisioning = validatePaperProvisioningAuthority(resolvedCwd);
  const configResult = paperConfig(resolvedCwd);
  let validation;
  let validationError = "";
  try {
    validation = validateBuildchainConfig(resolvedCwd, {
      requireLifecycleStages: ["verify"],
    });
  } catch (error) {
    validationError = error.message;
  }
  const runtime = selectPaperRuntime(
    runtimeFacts({
      buildchainRoot,
      buildchainVersion,
      buildchainRef: provisioning.value?.runtime?.ref || buildchainRef,
      buildchainSha,
    }),
    provisioning.value,
  );
  const lockPath = paperRuntimeLockPath(
    resolvedCwd,
    runtime,
    provisioning.value,
  );
  let lockEvaluation = {
    status: "missing-lock",
    compatible: false,
    drift: false,
    reasons: ["Buildchain contract lock is missing"],
  };
  try {
    const lock = readBuildchainContractLock(lockPath);
    if (lock) {
      const current = runtimeContractWorld(buildchainRoot);
      lockEvaluation = evaluateBuildchainContractLock({
        lock,
        current,
        runtimeRef: runtime.ref,
        runtimeSha: runtime.resolvedSha,
        runtimeClass: /alpha/i.test(runtime.ref) ? "alpha" : "stable",
      });
    }
  } catch (error) {
    lockEvaluation = {
      status: "invalid-lock",
      compatible: false,
      drift: false,
      reasons: [error.message],
    };
  }
  const agentEntry = collectPaperAgentEntry({
    cwd: resolvedCwd,
    buildchainSha: runtime.resolvedSha,
    mode: agentEntryMode,
    runtimeAdmission: {
      compatible: lockEvaluation.compatible,
      sha: runtime.resolvedSha,
      ref: runtime.ref,
    },
  });
  const source = {
    repositoryRoot: gitValue(resolvedCwd, ["rev-parse", "--show-toplevel"]),
    head: gitValue(resolvedCwd, ["rev-parse", "HEAD"]),
    tree: gitValue(resolvedCwd, ["rev-parse", "HEAD^{tree}"]),
    branch: gitValue(resolvedCwd, ["branch", "--show-current"]),
    clean: gitResult(resolvedCwd, ["status", "--porcelain"]).stdout === "",
  };
  const packageName = status.identity.package;
  const repository = status.identity.repository;
  const expectedPublisher = expectedPaperTrustedPublisher(provisioning.value, {
    repository,
    workflow: path.posix.basename(PAPER_PATHS.releaseWorkflow),
  });
  const npm =
    offline || !packageName
      ? {
          package: {
            status: "unknown",
            exists: null,
            version: "",
            registry,
            errorCode: offline ? "offline" : "package-unresolved",
          },
          auth: {
            status: "unknown",
            authenticated: null,
            identity: "",
            errorCode: offline ? "offline" : "package-unresolved",
          },
          trust: {
            status: "unknown",
            configured: null,
            publishers: [],
            errorCode: offline ? "offline" : "package-unresolved",
          },
        }
      : {
          package: liveNpmPackageObservation(
            packageName,
            registry,
            resolvedCwd,
          ),
          auth: liveNpmAuthObservation(registry, resolvedCwd),
          trust: liveNpmTrustObservation(
            packageName,
            registry,
            resolvedCwd,
            expectedPublisher,
          ),
        };
  const repositoryPermissions = offline
    ? {
        status: "unknown",
        repository,
        canWrite: null,
        errorCode: "offline",
      }
    : liveRepositoryPermissionObservation(repository, resolvedCwd);
  const repositoryActions = offline
    ? {
        status: "unknown",
        defaultWorkflowPermissions: "",
        canApprovePullRequestReviews: null,
        errorCode: "offline",
      }
    : liveRepositoryActionsPolicyObservation(repository, resolvedCwd);
  const generatedWriteAuthority = offline
    ? {
        status: "unknown",
        configured: null,
        mode: "",
        errorCode: "offline",
      }
    : liveGeneratedWriteAuthorityObservation(repository, resolvedCwd);
  const toolchain = localToolchainObservation(
    resolvedCwd,
    configResult.loaded?.config?.publication,
  );
  return paperPreflightReport({
    agentEntry,
    generatedWriteAuthority,
    lockEvaluation,
    npm,
    offline,
    provisioning,
    repositoryActions,
    repositoryPermissions,
    resolvedCwd,
    runtime,
    source,
    status,
    toolchain,
    validationError,
  });
}

function paperPreflightReport({
  agentEntry,
  generatedWriteAuthority,
  lockEvaluation,
  npm,
  offline,
  provisioning,
  repositoryActions,
  repositoryPermissions,
  resolvedCwd,
  runtime,
  source,
  status,
  toolchain,
  validationError,
}) {
  const checks = [
    ...paperPreflightLocalChecks({
      agentEntry,
      provisioning,
      validationError,
      source,
      toolchain,
      runtime,
      lockEvaluation,
    }),
    ...paperPreflightRepositoryChecks({
      repositoryPermissions,
      repositoryActions,
      generatedWriteAuthority,
    }),
    ...paperPreflightPublicationChecks({ npm, status }),
  ];
  const blockingChecks = checks.filter(
    (entry) => entry.blocking && ["fail", "unknown"].includes(entry.status),
  );
  const externalMutationChecks = checks.filter(
    (entry) =>
      entry.scope === "external-mutation" &&
      ["fail", "pending", "unknown"].includes(entry.status),
  );
  const nextActions = paperPreflightNextActions({
    validationError,
    source,
    lockEvaluation,
    npm,
    repositoryActions,
    generatedWriteAuthority,
    status,
  });
  return {
    schemaVersion: 1,
    contract: PAPER_PREFLIGHT_CONTRACT,
    ok: blockingChecks.length === 0,
    localReady: blockingChecks.length === 0,
    readyForExternalMutation:
      blockingChecks.length === 0 && externalMutationChecks.length === 0,
    cwd: resolvedCwd,
    offline,
    identity: status.identity,
    source,
    toolchain,
    runtime: {
      ...runtime,
      admission: {
        contractLockPath: PAPER_PATHS.contractLock,
        status: lockEvaluation.status,
        compatible: lockEvaluation.compatible === true,
        drift: lockEvaluation.drift === true,
        reasons: lockEvaluation.reasons || [],
      },
    },
    provisioning: {
      path: PAPER_PATHS.provisioningAuthority,
      valid: provisioning.valid,
      authorityDigest: provisioning.value?.authorityDigest || "",
      policyDigest: provisioning.value?.policy?.policyDigest || "",
      errors: provisioning.errors,
    },
    agentEntry,
    repositoryPermissions,
    repositoryActions,
    generatedWriteAuthority,
    npm,
    deterministicBuild: status.deterministicBuild,
    releaseState: {
      transaction: status.transaction,
      conflicts: status.conflicts,
    },
    checks,
    blockingNextActions: nextActions,
    status,
  };
}
