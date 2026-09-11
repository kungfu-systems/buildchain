import { resolveRecoverySource } from "./recovery.js";
import { getOctokit } from "@actions/github";
import { runtimeEntryProvider } from "./github.js";
import {
  preparedRuntimeSelection,
  runtimeSelector,
  selectExecutionRuntime,
} from "./selection.js";

export async function selectExecutionRuntimeAction(
  core,
  env,
  { providerFactory = runtimeEntryProvider, githubFactory = getOctokit } = {},
) {
  const retained = core.getInput("selection");
  const transport = retained
    ? preparedRuntimeSelection(JSON.parse(retained))
    : undefined;
  const github = githubFactory(core.getInput("token", { required: true }));
  let source = {
    repository: core.getInput("source-repository") || env.GITHUB_REPOSITORY,
    sha: core.getInput("source-sha") || env.GITHUB_SHA,
    ref: env.GITHUB_REF,
  };
  const resumeRunId = core.getInput("resume-run-id");
  if (resumeRunId) {
    const reader = providerFactory(github, {
      sourceRepository: source.repository,
      sourceSha: source.sha,
      actor: env.GITHUB_ACTOR,
      eventName: env.GITHUB_EVENT_NAME,
    });
    await reader.authorize({ origin: "runtime-parameter" });
    source = await resolveRecoverySource(
      {
        repository: source.repository,
        runId: resumeRunId,
        currentRunId: env.GITHUB_RUN_ID,
        workflow: env.GITHUB_WORKFLOW_REF?.slice(source.repository.length + 1),
      },
      reader.readRun,
    );
  }
  const provider = providerFactory(github, {
    sourceRepository: source.repository,
    sourceSha: source.sha,
    actor: env.GITHUB_ACTOR,
    eventName: env.GITHUB_EVENT_NAME,
  });
  const workflowSha = core.getInput("workflow-sha", { required: true });
  const workflowRef = core.getInput("workflow-ref", { required: true });
  const lockPath =
    core.getInput("contract-lock") ||
    transport?.contract?.path ||
    (/@(?:refs\/tags\/)?v4-alpha$/u.test(workflowRef)
      ? ".buildchain/alpha-contract-lock.json"
      : ".buildchain/contract-lock.json");
  if (
    lockPath.startsWith("/") ||
    lockPath.includes("\\") ||
    lockPath.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(
      "Contract lock path must be relative to the consumer repository",
    );
  const runtimeRef = core.getInput("runtime-ref");
  let selection;
  if (retained) {
    if (runtimeRef || resumeRunId)
      throw new Error(
        "Retained selection cannot be combined with a new runtime or recovery request",
      );
    selection = transport;
    if (selection.origin === "runtime-parameter")
      await provider.authorize({ origin: "runtime-parameter" });
    else {
      const retainedProvider = selection.source?.runId
        ? providerFactory(github, {
            sourceRepository: source.repository,
            sourceSha: selection.source.sha,
            actor: env.GITHUB_ACTOR,
          })
        : provider;
      const lock = await retainedProvider.readLock(lockPath);
      const expected = runtimeSelector({ workflowSha, lock });
      if (
        selection.origin !== expected.origin ||
        selection.sha !== expected.ref
      )
        throw new Error(
          "Runtime transport was not selected by this consumer entry",
        );
      if (lock)
        selection = {
          ...selection,
          ref: lock.buildchain.ref,
          class: lock.buildchain.ref === "v4-alpha" ? "alpha" : "stable",
          contract: { path: lockPath, digest: lock.buildchain.contractDigest },
        };
    }
    if (selection.source?.runId) {
      await provider.authorize({ origin: "runtime-parameter" });
      source = await resolveRecoverySource(
        {
          repository: source.repository,
          runId: selection.source.runId,
          currentRunId: env.GITHUB_RUN_ID,
          workflow: env.GITHUB_WORKFLOW_REF?.slice(
            source.repository.length + 1,
          ),
        },
        provider.readRun,
      );
    }
    if (
      selection.source?.repository !== source.repository ||
      selection.source?.sha !== source.sha
    )
      throw new Error("Runtime transport changed the admitted consumer source");
  } else {
    selection = await selectExecutionRuntime(
      {
        workflowSha: core.getInput("workflow-sha", { required: true }),
        runtimeRef,
        lock: runtimeRef ? undefined : await provider.readLock(lockPath),
      },
      provider,
    );
  }
  selection = {
    ...selection,
    source,
    contract: {
      ...selection.contract,
      path: selection.contract?.path || lockPath,
    },
  };
  core.setOutput("selection", selection);
  core.setOutput("source-sha", selection.source.sha);
  core.setOutput("source-ref", selection.source.ref);
  core.setOutput("repository", selection.repository);
  core.setOutput("sha", selection.sha);
  core.setOutput("ref", selection.ref);
  core.setOutput("class", selection.class);
  core.setOutput("origin", selection.origin);
  core.setOutput("override", String(selection.origin === "runtime-parameter"));
}
