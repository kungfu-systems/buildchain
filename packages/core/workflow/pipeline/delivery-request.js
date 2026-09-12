import { execFileSync } from "node:child_process";
import { recordDigest } from "../../release/discussion/envelope.js";
import { sourceQualificationPredicates } from "../../dev-delivery/source-proof/predicates.js";
import { createNativeCommandContract } from "../../dev-delivery/dev-delivery-warrant.js";
import { withPipelineSourceObjects } from "../../providers/github/pipeline-checkout.js";
import { pipelinePlatforms } from "./platforms.js";
import { pipelineCandidateRoot } from "./reconcile.js";
import {
  consumerWorkflows,
  PIPELINE_ENTRY,
} from "../../consumer/contract/entries.js";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function qualifyPipelineSourceRun(run, current, build) {
  const source = current.generation.source;
  const pull = run.pull_requests?.find(
    (pr) => pr.number === current.intent.source.pullRequest,
  );
  if (
    !Number.isSafeInteger(run.id) ||
    run.id < 1 ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !["pull_request", "repository_dispatch", "pull_request_review"].includes(
      run.event,
    ) ||
    run.repository?.full_name !== current.intent.repository ||
    (run.event === "pull_request" && run.head_sha !== source.commit) ||
    run.path?.split("@")[0] !== ".github/workflows/buildchain.yml" ||
    (run.event === "pull_request" &&
      pull?.base?.sha !== current.generation.baseCommit)
  )
    throw new Error(
      "Pipeline source run does not qualify the exact PR generation",
    );
  if (run.event !== "pull_request") {
    const { root, ...body } = build || {};
    if (
      root !== recordDigest(body) ||
      body.schema !== "buildchain.pipeline-build-readback/v1" ||
      body.runId !== run.id ||
      body.runAttempt !== run.run_attempt ||
      body.outcome !== "success" ||
      recordDigest(body.source) !== recordDigest(source)
    )
      throw new Error(
        "Attempt wake requires retained exact product build provider readback",
      );
  }
  pipelineEntry(run);
  return run;
}

function pipelineEntry(run) {
  const entries = (run.referenced_workflows || []).filter((workflow) =>
    workflow.path?.startsWith(`kungfu-systems/buildchain/${PIPELINE_ENTRY}@`),
  );
  if (entries.length !== 1 || !/^[0-9a-f]{40}$/u.test(entries[0].sha || ""))
    throw new Error("Pipeline build did not execute one exact published entry");
  const channel = entries[0].path.split("@").at(-1);
  if (!["v4", "v4-alpha"].includes(channel))
    throw new Error("Pipeline caller did not select a public floating channel");
  return channel;
}

function predicateInput(directory, current, run) {
  const source = current.generation.source;
  for (const [file, expected] of Object.entries(
    consumerWorkflows(pipelineEntry(run), source.configPath),
  )) {
    const bytes = execFileSync(
      "git",
      ["-C", directory, "show", `${source.commit}:${file}`],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    if (bytes !== expected)
      throw new Error(
        "Qualified source changed the minimal consumer workflow contract",
      );
  }
  const paths = execFileSync(
    "git",
    ["-C", directory, "ls-tree", "-r", "--name-only", "-z", source.commit],
    { maxBuffer: 32 * 1024 * 1024 },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  if (
    !paths.length ||
    paths.length > 50_000 ||
    paths.some((file) => /[\r\n]/u.test(file))
  )
    throw new Error(
      "Pipeline source inventory exceeds its qualification contract",
    );
  const policyPaths = paths.filter(
    (file) =>
      file === source.configPath || file.startsWith(".github/workflows/"),
  );
  const dependencies = paths.filter((file) =>
    /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.(?:toml|lock)|go\.(?:mod|sum))$/u.test(
      file,
    ),
  );
  return {
    cwd: directory,
    repository: current.intent.repository,
    protectedBase: current.intent.source.targetBranch,
    sourceHead: source.commit,
    qualifiedBase: current.generation.baseCommit,
    nodeVersion: "24",
    workingDirectory: ".",
    policyPaths: JSON.stringify(policyPaths),
    closurePaths: JSON.stringify(paths),
    dependencyPaths: JSON.stringify(
      dependencies.length ? dependencies : policyPaths,
    ),
    requiredContexts: JSON.stringify(["check"]),
  };
}

export async function preparePipelineDelivery(
  { current, run, build, runtimeSha, token, plan },
  withObjects = withPipelineSourceObjects,
) {
  qualifyPipelineSourceRun(run, current, build);
  if (!/^[0-9a-f]{40}$/u.test(runtimeSha || ""))
    throw new Error("Pipeline delivery requires the prepared exact runtime");
  const source = current.generation.source;
  const platforms = plan
    ? pipelinePlatforms(plan).map((entry) => entry.platform)
    : ["linux-x64"];
  const nativePlatform = platforms.includes("linux-x64")
    ? "linux-x64"
    : platforms[0];
  const predicates = await withObjects(
    {
      repository: current.intent.repository,
      sourceHead: source.commit,
      baseCommit: current.generation.baseCommit,
      token,
    },
    (directory) =>
      sourceQualificationPredicates(predicateInput(directory, current, run)),
  );
  // Native composition owns .buildchain/candidate beside the prepared runtime.
  // Do not bind one job's absolute workspace path into another runner's command.
  const nativeCommand = `node ../runtime/packages/core/workflow/commands/pipeline-build.mjs --platform ${nativePlatform} --config-path ${quote(source.configPath)}`;
  const environmentRoot = recordDigest({
    schema: "buildchain.pipeline-native-environment/v1",
    runtimeSha,
    node: "24",
    platform: nativePlatform,
    sourceContract: source.contract,
  });
  return {
    "target-branch": current.intent.source.targetBranch,
    "expected-pr-number": current.intent.source.pullRequest,
    "expected-head-sha": source.commit,
    "source-workflow-run-id": run.id,
    "pipeline-attempt": current.identity.id,
    "delivery-warrant-mode": "required",
    "delivery-class": "native-proof-required",
    "source-root": pipelineCandidateRoot(current),
    "source-identity-root": predicates.sourceIdentityRoot,
    "source-patch-root": predicates.sourcePatchRoot,
    "plan-root": predicates.planRoot,
    "closure-root": predicates.closureRoot,
    "dependency-root": predicates.dependencyRoot,
    "toolchain-root": predicates.toolchainRoot,
    "environment-root": environmentRoot,
    "native-command": nativeCommand,
    "native-platform": nativePlatform,
    "native-command-root":
      createNativeCommandContract(nativeCommand).commandRoot,
    "affected-paths-json": JSON.stringify(predicates.affectedPaths),
    "shard-evidence-roots-json": "[]",
    "required-status-checks": "check",
    "ready-label": "ready",
    "landing-mode": "queue",
    "queue-admission-context": "Queue admission lease",
    "active-lease-context": "Queue family lease/exact",
    "require-approval": true,
    "same-repository-only": true,
    "max-merges": 1,
    "dry-run": false,
  };
}
