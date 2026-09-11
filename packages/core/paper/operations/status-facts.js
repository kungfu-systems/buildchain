import path from "node:path";
import fs from "node:fs";
import {
  readReleaseTransaction,
  releaseTransactionPublicationState,
} from "../../release/publish-transaction.js";
import { toPosix, existingFileFact } from "./files.js";
import {
  PAPER_VISIBILITY_CONTRACT,
  SHA256_PATTERN,
  PAPER_NPM_BOOTSTRAP_CONTRACT,
  PAPER_SCAFFOLD_PATHS,
  GIT_SHA_PATTERN,
} from "./identity.js";
import {
  paperConfig,
  PAPER_PATHS,
  readJson,
  gitResult,
} from "../paper-repository.js";
import { readBuildchainContractLock } from "../../contracts/buildchain-contract.js";
import { PUBLICATION_REPRODUCIBILITY_RECEIPT_CONTRACT } from "../../publication/publication-reproducibility.js";
import {
  PUBLICATION_SEALED_BUNDLE_CONTRACT,
  verifyPublicationSealedBundle,
} from "../../publication/publication-sealed-bundle.js";
export function state(id, status, reason, evidence = []) {
  return {
    id,
    status,
    satisfied: status === "satisfied",
    reason,
    evidence: evidence.filter(Boolean),
  };
}
export function transactionCandidates(cwd, version) {
  const stateDir = path.resolve(cwd, ".buildchain/release-state");
  if (!fs.existsSync(stateDir) || !fs.statSync(stateDir).isDirectory()) {
    return [];
  }
  const preferred = new Set([`${version}.json`, `v${version}.json`]);
  return fs
    .readdirSync(stateDir)
    .filter((entry) => entry.endsWith(".json"))
    .sort((left, right) => {
      const leftRank = preferred.has(left) ? 0 : 1;
      const rightRank = preferred.has(right) ? 0 : 1;
      return leftRank - rightRank || left.localeCompare(right);
    })
    .map((entry) => {
      const filePath = path.join(stateDir, entry);
      try {
        const transaction = readReleaseTransaction(filePath);
        return {
          path: toPosix(path.relative(cwd, filePath)),
          transaction,
          error: "",
        };
      } catch (error) {
        return {
          path: toPosix(path.relative(cwd, filePath)),
          transaction: undefined,
          error: error.message,
        };
      }
    });
}
export function explicitVisibilityState(value, channel) {
  const entry = value?.channels?.[channel];
  return Boolean(
    value?.contract === PAPER_VISIBILITY_CONTRACT &&
    entry?.status === "visible" &&
    typeof entry.url === "string" &&
    entry.url &&
    SHA256_PATTERN.test(String(entry.evidenceDigest || "")),
  );
}
export function admissionSatisfied(value) {
  const digestPattern = /^(?:sha256:)?[0-9a-f]{64}$/i;
  if (value?.contract === "kungfu-buildchain-publication-admission") {
    return digestPattern.test(String(value.admissionDigest || ""));
  }
  if (value?.contract === "kungfu-buildchain-publication-capability") {
    return (
      value.decision === "allow" &&
      digestPattern.test(String(value.capabilityDigest || ""))
    );
  }
  return false;
}
export function bootstrapSatisfied(value) {
  return Boolean(
    value?.contract === PAPER_NPM_BOOTSTRAP_CONTRACT &&
    ["existing", "published"].includes(value?.publish?.status) &&
    value?.package?.name,
  );
}
export function trustSatisfied(value) {
  return Boolean(
    value?.contract === PAPER_NPM_BOOTSTRAP_CONTRACT &&
    value?.trust?.status === "configured",
  );
}
export function contentReadiness(cwd, publication) {
  const required = [...publication.sourcePaths, ...publication.metadataPaths];
  const missing = required.filter(
    (entry) => !fs.existsSync(path.resolve(cwd, entry)),
  );
  return {
    ok: required.length > 0 && missing.length === 0,
    required,
    missing,
  };
}
export function releaseTransactionFacts(candidates, version) {
  const matching = candidates.filter(({ transaction }) => {
    if (!transaction) return false;
    return (
      String(transaction.version || "").replace(/^v/, "") ===
      String(version || "").replace(/^v/, "")
    );
  });
  const selected =
    matching[0] ||
    candidates.find(({ transaction }) => transaction) ||
    undefined;
  const publicationState = selected?.transaction
    ? releaseTransactionPublicationState(selected.transaction)
    : "";
  return {
    matching,
    selected,
    publicationState,
  };
}
export function collectPaperGovernanceFacts(resolvedCwd) {
  const configResult = paperConfig(resolvedCwd);
  const loaded = configResult.loaded;
  const publication = loaded?.config?.publication;
  const publish = loaded?.config?.publish;
  const packageName = publish?.package || publish?.mainPackage || "";
  const version = publication?.version || "";
  const configFact = existingFileFact(
    resolvedCwd,
    loaded?.path || PAPER_PATHS.config,
  );
  const scaffoldFacts = PAPER_SCAFFOLD_PATHS.map((relativePath) =>
    existingFileFact(resolvedCwd, relativePath),
  );
  const contractLockPath = path.resolve(resolvedCwd, PAPER_PATHS.contractLock);
  const contractLockJson = readJson(contractLockPath);
  let contractLock;
  let contractLockError = contractLockJson.error;
  if (contractLockJson.exists && !contractLockError) {
    try {
      contractLock = readBuildchainContractLock(contractLockPath);
    } catch (error) {
      contractLockError = error.message;
    }
  }
  const gitRepo = gitResult(resolvedCwd, [
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  const scaffoldOk = Boolean(
    !configResult.error && scaffoldFacts.every(Boolean),
  );
  const governedOk = Boolean(
    scaffoldOk &&
    contractLock &&
    GIT_SHA_PATTERN.test(contractLock.buildchain?.resolvedSha || "") &&
    SHA256_PATTERN.test(contractLock.buildchain?.contractDigest || "") &&
    SHA256_PATTERN.test(contractLock.buildchain?.compatibilityDigest || "") &&
    gitRepo.ok &&
    gitRepo.stdout === "true",
  );
  return {
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
  };
}
export function collectPaperEvidenceFacts(resolvedCwd, publication, version) {
  const admissionInputs = [PAPER_PATHS.capability, PAPER_PATHS.admission].map(
    (relativePath) => ({
      relativePath,
      ...readJson(path.resolve(resolvedCwd, relativePath)),
    }),
  );
  const admitted = admissionInputs.find((entry) =>
    admissionSatisfied(entry.value),
  );
  const bootstrap = readJson(
    path.resolve(resolvedCwd, PAPER_PATHS.npmBootstrap),
  );
  const trust = readJson(path.resolve(resolvedCwd, PAPER_PATHS.npmTrust));
  const bootstrapValue = bootstrap.value;
  const trustValue = trust.value || bootstrap.value;
  const content = publication
    ? contentReadiness(resolvedCwd, publication)
    : { ok: false, required: [], missing: [] };
  const reproducibility = readJson(
    path.resolve(resolvedCwd, PAPER_PATHS.reproducibilityReceipt),
  );
  const deterministic = Boolean(
    reproducibility.value?.contract ===
      PUBLICATION_REPRODUCIBILITY_RECEIPT_CONTRACT &&
    reproducibility.value?.status === "passed" &&
    reproducibility.value?.qualifying === true,
  );
  const sealed = readJson(path.resolve(resolvedCwd, PAPER_PATHS.sealedBundle));
  let sealedOk = false;
  let sealedError = sealed.error;
  if (sealed.value?.contract === PUBLICATION_SEALED_BUNDLE_CONTRACT) {
    try {
      verifyPublicationSealedBundle({
        bundleRoot: resolvedCwd,
        manifest: sealed.value,
      });
      sealedOk = true;
    } catch (error) {
      sealedError = error.message;
    }
  }
  const candidates = transactionCandidates(resolvedCwd, version);
  const transactionFacts = releaseTransactionFacts(candidates, version);
  const packagePublished = [
    "package-published",
    "alpha-complete",
    "release-complete",
  ].includes(transactionFacts.publicationState);
  const alphaComplete = transactionFacts.publicationState === "alpha-complete";
  const visibility = readJson(
    path.resolve(resolvedCwd, PAPER_PATHS.visibility),
  );
  const stagingVisible = explicitVisibilityState(visibility.value, "staging");
  const productionVisible = explicitVisibilityState(
    visibility.value,
    "production",
  );
  return {
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
  };
}
