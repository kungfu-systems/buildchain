import fs from "node:fs";
import path from "node:path";

export const BUILDCHAIN_DIR = ".buildchain";
export const BUILDCHAIN_CONFIG_PATH = ".buildchain/buildchain.toml";
export const LEGACY_BUILDCHAIN_CONFIG_PATH = "buildchain.toml";
export const BUILDCHAIN_CONTRACT_LOCK_PATH = ".buildchain/contract-lock.json";
export const LEGACY_BUILDCHAIN_CONTRACT_LOCK_PATH = "buildchain.contract-lock.json";
export const BUILDCHAIN_KFD_ROOT = ".buildchain/kfd";
export const BUILDCHAIN_KFD1_DIR = ".buildchain/kfd/kfd-1";
export const BUILDCHAIN_KFD2_DIR = ".buildchain/kfd/kfd-2";
export const BUILDCHAIN_KFD3_DIR = ".buildchain/kfd/kfd-3";
export const BUILDCHAIN_KFD4_DIR = ".buildchain/kfd/kfd-4";
export const BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH = ".buildchain/kfd/kfd-1/contract-world.witness.json";
export const BUILDCHAIN_KFD1_RELEASE_GATE_PATH = ".buildchain/kfd/kfd-1/release-gate.json";
export const BUILDCHAIN_KFD1_VERIFY_RESULT_PATH = ".buildchain/kfd/kfd-1/verify-result.json";
export const BUILDCHAIN_KFD2_RELEASE_CLAIMS_PATH = ".buildchain/kfd/kfd-2/release-claims.json";
export const BUILDCHAIN_KFD2_CLAIM_ARGS_PATH = ".buildchain/kfd/kfd-2/buildchain-claim-args.txt";
export const BUILDCHAIN_KFD2_CLAIMS_DIR = ".buildchain/kfd/kfd-2/claims";
export const BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH = ".buildchain/kfd/kfd-3/surfaces.json";
export const BUILDCHAIN_KFD3_COLLABORATION_INTERFACE_PATH = ".buildchain/kfd/kfd-3/collaboration-interface.json";
export const BUILDCHAIN_KFD3_PREBUILD_WITNESS_PATH = ".buildchain/kfd/kfd-3/collaboration-interface.prebuild.json";
export const BUILDCHAIN_KFD3_ARTIFACT_WITNESS_PATH = ".buildchain/kfd/kfd-3/collaboration-interface.artifact.json";
export const BUILDCHAIN_KFD3_CAPABILITY_QUERY_PATH = ".buildchain/kfd/kfd-3/capability-query.json";
export const LEGACY_BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH = "buildchain.kfd3.json";
export const LEGACY_BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATHS = Object.freeze([
  ".buildchain/kfd/kfd-3-surfaces.json",
  LEGACY_BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH,
]);
export const BUILDCHAIN_RELEASE_PASSPORT_PATH = ".buildchain/release-passport/buildchain.release.json";
export const LEGACY_BUILDCHAIN_RELEASE_PASSPORT_PATH = "buildchain.release.json";

export const BUILDCHAIN_GENERATED_DIRS = Object.freeze([
  ".buildchain/artifacts",
  ".buildchain/diagnostics",
  ".buildchain/logs",
  ".buildchain/tmp",
  ".buildchain/runtime",
  ".buildchain/release-state",
  ".buildchain/release-evidence",
  ".buildchain/downloaded-manifests",
  ".buildchain/downloaded-diagnostics",
  ".buildchain/downloaded-relay-manifests",
  ".buildchain/relayed-artifacts",
]);

export function toPosixPath(value) {
  return String(value || "").split(path.sep).join("/");
}

export function repoPath(cwd, relativePath) {
  return path.join(cwd, relativePath);
}

export function firstExistingRepoPath(cwd, candidates = []) {
  for (const candidate of candidates) {
    if (fs.existsSync(repoPath(cwd, candidate))) {
      return candidate;
    }
  }
  return candidates[0] || "";
}

export function resolveBuildchainConfigPath(cwd = process.cwd()) {
  return firstExistingRepoPath(cwd, [
    BUILDCHAIN_CONFIG_PATH,
    LEGACY_BUILDCHAIN_CONFIG_PATH,
  ]);
}

export function resolveBuildchainContractLockPath(cwd = process.cwd()) {
  return firstExistingRepoPath(cwd, [
    BUILDCHAIN_CONTRACT_LOCK_PATH,
    LEGACY_BUILDCHAIN_CONTRACT_LOCK_PATH,
  ]);
}

export function resolveKfd3SurfaceRegistryPath(cwd = process.cwd()) {
  return firstExistingRepoPath(cwd, [
    BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH,
    ...LEGACY_BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATHS,
  ]);
}

export function resolveReleasePassportPath(cwd = process.cwd()) {
  return firstExistingRepoPath(cwd, [
    BUILDCHAIN_RELEASE_PASSPORT_PATH,
    LEGACY_BUILDCHAIN_RELEASE_PASSPORT_PATH,
  ]);
}

export function discoverBuildchainRepoFiles(cwd = process.cwd()) {
  const files = [
    {
      kind: "config",
      canonical: BUILDCHAIN_CONFIG_PATH,
      legacy: LEGACY_BUILDCHAIN_CONFIG_PATH,
      tracked: true,
    },
    {
      kind: "contract-lock",
      canonical: BUILDCHAIN_CONTRACT_LOCK_PATH,
      legacy: LEGACY_BUILDCHAIN_CONTRACT_LOCK_PATH,
      tracked: true,
    },
    {
      kind: "kfd-3-surface-registry",
      canonical: BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH,
      legacy: LEGACY_BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATHS,
      tracked: true,
    },
    {
      kind: "kfd-1-contract-world-witness",
      canonical: BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH,
      legacy: [
        ".buildchain/kfd-1/contract-world.witness.json",
        ".buildchain/kfd/buildchain-kfd-1-witness.json",
      ],
      tracked: true,
    },
    {
      kind: "kfd-1-release-gate",
      canonical: BUILDCHAIN_KFD1_RELEASE_GATE_PATH,
      legacy: [".buildchain/kfd-1/release-gate.json"],
      tracked: true,
    },
    {
      kind: "kfd-1-verify-result",
      canonical: BUILDCHAIN_KFD1_VERIFY_RESULT_PATH,
      legacy: [".buildchain/kfd-1/verify-result.json"],
      tracked: false,
    },
    {
      kind: "kfd-2-release-claims",
      canonical: BUILDCHAIN_KFD2_RELEASE_CLAIMS_PATH,
      legacy: [
        ".buildchain/kfd-2/release-claims.json",
        ".buildchain/kfd-2/public-release-trust.claim.json",
      ],
      tracked: true,
    },
    {
      kind: "kfd-2-claim-args",
      canonical: BUILDCHAIN_KFD2_CLAIM_ARGS_PATH,
      legacy: [".buildchain/kfd-2/buildchain-claim-args.txt"],
      tracked: true,
    },
    {
      kind: "kfd-2-claims",
      canonical: BUILDCHAIN_KFD2_CLAIMS_DIR,
      legacy: [".buildchain/kfd/kfd-2-claims", ".buildchain/kfd-2/claims"],
      tracked: false,
    },
    {
      kind: "kfd-3-collaboration-interface",
      canonical: BUILDCHAIN_KFD3_COLLABORATION_INTERFACE_PATH,
      legacy: [".buildchain/kfd-3/collaboration-interface.json"],
      tracked: true,
    },
    {
      kind: "kfd-3-prebuild-witness",
      canonical: BUILDCHAIN_KFD3_PREBUILD_WITNESS_PATH,
      legacy: [
        ".buildchain/kfd-3/collaboration-interface.prebuild.json",
        ".buildchain/kfd/buildchain-kfd-3-prebuild-witness.json",
      ],
      tracked: true,
    },
    {
      kind: "kfd-3-artifact-witness",
      canonical: BUILDCHAIN_KFD3_ARTIFACT_WITNESS_PATH,
      legacy: [
        ".buildchain/kfd-3/collaboration-interface.artifact.json",
        ".buildchain/kfd/buildchain-kfd-3-artifact-witness.json",
      ],
      tracked: true,
    },
    {
      kind: "kfd-3-capability-query",
      canonical: BUILDCHAIN_KFD3_CAPABILITY_QUERY_PATH,
      legacy: [".buildchain/kfd-3/capability-query.json"],
      tracked: true,
    },
    {
      kind: "release-passport",
      canonical: BUILDCHAIN_RELEASE_PASSPORT_PATH,
      legacy: LEGACY_BUILDCHAIN_RELEASE_PASSPORT_PATH,
      tracked: false,
    },
  ];
  return files.map((entry) => {
    const canonicalExists = fs.existsSync(repoPath(cwd, entry.canonical));
    const legacyPaths = Array.isArray(entry.legacy) ? entry.legacy : [entry.legacy].filter(Boolean);
    const existingLegacyPaths = legacyPaths.filter((legacy) => fs.existsSync(repoPath(cwd, legacy)));
    const legacyExists = existingLegacyPaths.length > 0;
    return {
      ...entry,
      legacy: legacyPaths,
      canonicalExists,
      legacyExists,
      existingLegacyPaths,
      activePath: canonicalExists ? entry.canonical : legacyExists ? existingLegacyPaths[0] : entry.canonical,
      migrationNeeded: !canonicalExists && legacyExists,
    };
  });
}

export function planBuildchainLayoutMigration({ cwd = process.cwd() } = {}) {
  const entries = discoverBuildchainRepoFiles(cwd);
  const moves = entries
    .filter((entry) => entry.migrationNeeded)
    .flatMap((entry) => entry.existingLegacyPaths.map((legacy) => ({
      kind: entry.kind,
      from: legacy,
      to: entry.canonical,
      tracked: entry.tracked,
    })));
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-repository-layout-migration",
    cwd: path.resolve(cwd),
    canonicalRoot: BUILDCHAIN_DIR,
    status: moves.length > 0 ? "migration-needed" : "current",
    files: entries,
    generatedDirs: BUILDCHAIN_GENERATED_DIRS,
    moves,
  };
}

export function migrateBuildchainLayout({ cwd = process.cwd(), write = false, force = false } = {}) {
  const plan = planBuildchainLayoutMigration({ cwd });
  const applied = [];
  if (write) {
    for (const move of plan.moves) {
      const from = repoPath(cwd, move.from);
      const to = repoPath(cwd, move.to);
      if (fs.existsSync(to) && !force) {
        throw new Error(`${move.to} already exists; pass --force to overwrite`);
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      applied.push(move);
    }
  }
  return {
    ...plan,
    write,
    force,
    status: write && applied.length === plan.moves.length ? "applied" : plan.status,
    applied,
  };
}
