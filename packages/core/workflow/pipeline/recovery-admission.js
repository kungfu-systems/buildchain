import { recordDigest } from "../../release/discussion/envelope.js";
import { readPipelineCaller } from "../../providers/github/pipeline-run-entry.js";
import { RECOVERY_ENTRY } from "../../consumer/contract/entries.js";

export async function recoveryExecution(host, definitionSha) {
  const { run } = await host.runs.read(host.runId, host.runAttempt);
  const definitions = (run.referenced_workflows || []).filter((item) =>
    item.path?.startsWith(`kungfu-systems/buildchain/${RECOVERY_ENTRY}@`),
  );
  if (
    run.event !== "workflow_dispatch" ||
    run.status !== "in_progress" ||
    run.repository?.full_name !== host.repository ||
    run.head_repository?.full_name !== host.repository ||
    run.path?.split("@")[0] !== ".github/workflows/buildchain-recover.yml" ||
    definitions.length !== 1 ||
    definitions[0].sha !== definitionSha ||
    !/^[0-9a-f]{40}$/u.test(definitionSha || "")
  )
    throw new Error(
      "Recovery must execute the exact canonical entry from the same consumer repository",
    );
  const channel = definitions[0].path
    .split("@")
    .at(-1)
    .replace(/^refs\/tags\//u, "");
  if (!["v4", "v4-alpha"].includes(channel))
    throw new Error("Recovery entry must be a published floating channel");
  return {
    run,
    channel,
    entry: {
      repository: "kungfu-systems/buildchain",
      workflow: RECOVERY_ENTRY,
      sha: definitionSha,
    },
  };
}

export async function admitRecoverySource(session, execution, host) {
  const current = session.observed.history.at(-1);
  const original = current.generation.source;
  const source = await host.source.source(original.commit, original.configPath);
  if (
    recordDigest(source.identity) !== recordDigest(original) ||
    host.selection.source?.sha !== original.commit ||
    host.selection.source?.repository !== host.repository
  )
    throw new Error(
      "Recovery source, config or selected runtime source changed",
    );
  const caller = await readPipelineCaller(
    execution.run,
    original.configPath,
    host.request,
    host.repository,
  );
  const admission = await host.source.observeIntent(
    session.intent,
    current.generation,
    { "config-path": original.configPath },
  );
  if (
    !admission.live.source ||
    recordDigest(admission.live.source) !== recordDigest(original) ||
    admission.live.targetBranch !== session.intent.source.targetBranch ||
    (!admission.live.merged &&
      (admission.live.state !== "open" ||
        admission.live.routeEnabled === false ||
        admission.live.baseCommit !== current.generation.baseCommit))
  )
    throw new Error(
      "Selected source was closed, superseded or rebased; use its current admitted attempt",
    );
  return {
    source,
    admission,
    caller,
  };
}

export async function recoveryPredecessorRuns(session, host) {
  const current = session.observed.history.at(-1);
  const keys = [
    ...new Map(
      current.runs.map((writer) => [
        `${writer.runId}:${writer.runAttempt}`,
        writer,
      ]),
    ).values(),
  ];
  if (keys.length > 100)
    throw new Error("Recovery predecessor run inventory exceeds its bound");
  const observations = [];
  for (const writer of keys) {
    if (
      Number(writer.runId) === host.runId &&
      Number(writer.runAttempt) === host.runAttempt
    )
      throw new Error("Recovery cannot replace its own live execution");
    const { run } = await host.runs.read(
      Number(writer.runId),
      Number(writer.runAttempt),
    );
    if (
      run.repository?.full_name !== host.repository ||
      run.head_repository?.full_name !== host.repository
    )
      throw new Error(
        "Recovery predecessor execution crossed a repository or fork boundary",
      );
    observations.push(run);
  }
  return {
    schema: "buildchain.pipeline-recovery-executions/v1",
    predecessor: current.identity.id,
    runs: observations,
    terminal: observations.every(
      (run) => run.status === "completed" && run.conclusion,
    ),
  };
}
