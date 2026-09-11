import path from "node:path";
import {
  paperConfig,
  gitValue,
  PAPER_PATHS,
  parsePaperVersion,
  resolvePaperRepository,
} from "../paper-repository.js";
import {
  PAPER_BUILD_PLAN_CONTRACT,
  GIT_SHA_PATTERN,
  PAPER_ALPHA_PLAN_CONTRACT,
  PAPER_RESUME_PLAN_CONTRACT,
} from "./identity.js";
import { collectPaperStatus } from "./status.js";
export function createPaperBuildPlan({
  cwd = process.cwd(),
  sourceSha = "",
  pullToolchain = true,
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const configResult = paperConfig(resolvedCwd);
  if (configResult.error) throw new Error(configResult.error);
  const resolvedSha = sourceSha || gitValue(resolvedCwd, ["rev-parse", "HEAD"]);
  return {
    schemaVersion: 1,
    contract: PAPER_BUILD_PLAN_CONTRACT,
    ok: GIT_SHA_PATTERN.test(resolvedSha),
    cwd: resolvedCwd,
    dryRun: true,
    sourceSha: resolvedSha,
    toolchain: configResult.loaded.config.publication.toolchain,
    pullToolchain,
    output: PAPER_PATHS.reproducibilityReceipt,
    promotion: "first-byte-identical-clean-build",
    delegatesTo: "buildchain publication-artifact reproducibility --promote",
    nextActions: [
      {
        id: "execute-build",
        command: "buildchain paper build --execute --json",
        description:
          "Run two independent clean builds and promote only byte-identical qualifying outputs.",
      },
    ],
  };
}
export function resolvePaperChannelRef(cwd, ref) {
  const candidates = [
    {
      observedRef: `refs/remotes/origin/${ref}`,
      observation: "origin-tracking-ref",
    },
    {
      observedRef: `refs/heads/${ref}`,
      observation: "local-branch-ref",
    },
  ];
  for (const candidate of candidates) {
    const sha = gitValue(cwd, [
      "rev-parse",
      "--verify",
      `${candidate.observedRef}^{commit}`,
    ]);
    if (GIT_SHA_PATTERN.test(sha)) {
      return {
        sha,
        ...candidate,
      };
    }
  }
  return {
    sha: "",
    observedRef: "",
    observation: "unresolved",
  };
}
export function createPaperAlphaPlan({
  cwd = process.cwd(),
  sourceRef = "",
  targetRef = "",
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const configResult = paperConfig(resolvedCwd);
  if (configResult.error) throw new Error(configResult.error);
  const publication = configResult.loaded.config.publication;
  const parsed = parsePaperVersion(publication.version);
  const line = `v${parsed.major}.${parsed.minor}`;
  const source = sourceRef || `dev/v${parsed.major}/${line}`;
  const target = targetRef || `alpha/v${parsed.major}/${line}`;
  const repository = resolvePaperRepository(resolvedCwd);
  const sourceObservation = resolvePaperChannelRef(resolvedCwd, source);
  const targetObservation = resolvePaperChannelRef(resolvedCwd, target);
  const currentBranch = gitValue(resolvedCwd, ["branch", "--show-current"]);
  return {
    schemaVersion: 1,
    contract: PAPER_ALPHA_PLAN_CONTRACT,
    ok: Boolean(repository && source && target && source !== target),
    cwd: resolvedCwd,
    dryRun: true,
    repository,
    package: configResult.loaded.config.publish?.package || "",
    publicationVersion: parsed.version,
    channel: "alpha",
    source: {
      ref: source,
      ...sourceObservation,
    },
    target: {
      ref: target,
      ...targetObservation,
    },
    currentBranch,
    mutation: {
      kind: "github-protected-channel-pr",
      directPublish: false,
      directMerge: false,
      command: `gh pr create --repo ${repository || "<owner/repo>"} --base ${target} --head ${source}`,
    },
    gates: [
      "source is the protected dev channel for the configured semver line",
      "target is the protected alpha channel",
      "the paper release workflow seals exact bytes and uses npm OIDC",
      "this command opens a PR but never merges it or publishes directly",
    ],
    nextActions: [
      {
        id: "open-alpha-pr",
        command: "buildchain paper alpha --execute --json",
        description: "Open or reuse the protected dev-to-alpha publication PR.",
      },
    ],
  };
}
export function createPaperResumePlan({
  cwd = process.cwd(),
  runtimeRef = "",
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const status = collectPaperStatus({ cwd: resolvedCwd });
  const transaction = status.transaction;
  if (!transaction) {
    return {
      schemaVersion: 1,
      contract: PAPER_RESUME_PLAN_CONTRACT,
      ok: false,
      cwd: resolvedCwd,
      dryRun: true,
      resumable: false,
      reason: "no-release-transaction",
      transaction: null,
      nextActions: [
        {
          id: "start-alpha",
          command: "buildchain paper alpha --json",
          description:
            "No transaction exists; plan the protected Alpha publication first.",
        },
      ],
    };
  }
  if (
    ["alpha-complete", "release-complete"].includes(
      transaction.publicationState,
    )
  ) {
    return {
      schemaVersion: 1,
      contract: PAPER_RESUME_PLAN_CONTRACT,
      ok: true,
      cwd: resolvedCwd,
      dryRun: true,
      resumable: false,
      reason: "transaction-complete",
      transaction,
      nextActions: [],
    };
  }
  const targetRef = transaction.targetRef;
  const command = [
    "gh workflow run .github/workflows/public-release-paper.yml",
    targetRef ? `--ref ${targetRef}` : "",
    runtimeRef ? `-f runtime-ref=${runtimeRef}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    schemaVersion: 1,
    contract: PAPER_RESUME_PLAN_CONTRACT,
    ok: Boolean(targetRef),
    cwd: resolvedCwd,
    dryRun: true,
    resumable: Boolean(targetRef),
    reason: targetRef
      ? "rerun-sealed-paper-release"
      : "transaction-target-ref-missing",
    transaction,
    mutation: {
      kind: "github-workflow-dispatch",
      directPublish: false,
      command,
    },
    nextActions: targetRef
      ? [
          {
            id: "dispatch-resume",
            command: "buildchain paper resume --execute --json",
            description:
              "Dispatch the thin repository workflow against the exact transaction target ref.",
          },
        ]
      : [],
  };
}
