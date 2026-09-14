import { createHash } from "node:crypto";
import { runtimeSelector } from "../../runtime/entry/selection.js";
import { pipelineRunEntry, readPipelineCaller } from "./pipeline-run-entry.js";
import { recordDigest } from "../../release/discussion/envelope.js";

export async function pipelineEntryRuns(host, publishedAt) {
  const created = encodeURIComponent(
    `>=${new Date(publishedAt).toISOString()}`,
  );
  const prefix = `/repos/${host.repository}/actions/workflows/buildchain.yml/runs`;
  const runs = [],
    ids = new Set();
  for (let page = 1; page <= 10; page++) {
    const result = await host.request(
      `${prefix}?event=pull_request&status=completed&created=${created}&per_page=100&page=${page}`,
      { allow404: true },
    );
    if (!result && page === 1) return [];
    if (
      !Array.isArray(result?.workflow_runs) ||
      result.workflow_runs.length > 100
    )
      throw new Error("Published entry run inventory is incomplete");
    for (const run of result.workflow_runs) {
      if (
        !Number.isSafeInteger(run.id) ||
        run.id < 1 ||
        ids.has(run.id) ||
        !Number.isSafeInteger(run.run_attempt) ||
        run.run_attempt < 1 ||
        !Number.isFinite(Date.parse(run.created_at))
      )
        throw new Error(
          "Published entry run inventory has ambiguous coordinates",
        );
      ids.add(run.id);
      runs.push(run);
    }
    if (result.workflow_runs.length < 100)
      return runs.sort(
        (a, b) =>
          Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id,
      );
  }
  throw new Error(
    "Published entry run inventory exceeds its complete-read bound",
  );
}

async function sourceLock(host, source, channel) {
  const pathname =
    channel === "v4-alpha"
      ? ".buildchain/alpha-contract-lock.json"
      : ".buildchain/contract-lock.json";
  const file = await host.request(
    `/repos/${host.repository}/contents/${pathname}?ref=${source.commit}`,
    { allow404: true },
  );
  if (!file) return { value: undefined, evidence: null };
  if (
    file.type !== "file" ||
    file.encoding !== "base64" ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > 1024 * 1024 ||
    typeof file.content !== "string" ||
    file.content.length > 2 * 1024 * 1024
  )
    throw new Error("Published entry runtime lock exceeds its source boundary");
  const bytes = Buffer.from(file.content, "base64");
  const blob = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (bytes.length !== file.size || blob !== file.sha)
    throw new Error("Published entry runtime lock bytes changed");
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (
    value.schema === "buildchain.consumer-contract-lock/v2" &&
    value.configDigest !== source.configDigest
  )
    throw new Error(
      "Published entry runtime lock belongs to another consumer configuration",
    );
  return {
    value,
    evidence: {
      path: pathname,
      blob,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    },
  };
}

export async function pipelineEntryRun(run, plan, source, host) {
  if (
    run.event !== "pull_request" ||
    run.status !== "completed" ||
    run.repository?.full_name !== host.repository ||
    run.head_repository?.full_name !== host.repository ||
    run.path?.split("@")[0] !== ".github/workflows/buildchain.yml" ||
    !Number.isFinite(Date.parse(run.created_at)) ||
    Date.parse(run.created_at) < Date.parse(source.candidate.publishedAt)
  )
    return null;
  const entry = pipelineRunEntry(run);
  if (entry.recovery || entry.definition.sha !== source.candidate.sha)
    return null;
  const consumer = await host.source.source(
    run.head_sha,
    plan.source.configPath,
  );
  if (recordDigest(consumer.plan) !== plan.contractRoot) return null;
  if (
    consumer.identity.commit !== run.head_sha ||
    consumer.identity.configPath !== plan.source.configPath ||
    consumer.identity.repository !== host.repository
  )
    throw new Error("Published entry consumer source changed during readback");
  await readPipelineCaller(
    run,
    consumer.identity.configPath,
    host.request,
    host.repository,
  );
  const lock = await sourceLock(host, consumer.identity, entry.channel);
  const selection = runtimeSelector({
    lock: lock.value,
    workflowSha: entry.definition.sha,
  });
  if (selection.ref !== source.candidate.sha) return null;
  return {
    source: consumer.identity,
    entry: entry.definition,
    selection,
    lock: lock.evidence,
  };
}

export async function pipelineEntryCheck(run, host) {
  const checks = [],
    ids = new Set();
  const prefix = `/repos/${host.repository}/commits/${run.head_sha}/check-runs`;
  for (let page = 1; page <= 10; page++) {
    const result = await host.request(
      `${prefix}?check_name=check&filter=all&per_page=100&page=${page}`,
    );
    if (!Array.isArray(result?.check_runs) || result.check_runs.length > 100)
      throw new Error("Published entry check inventory is incomplete");
    for (const check of result.check_runs) {
      if (!Number.isSafeInteger(check.id) || check.id < 1 || ids.has(check.id))
        throw new Error(
          "Published entry check inventory has ambiguous identities",
        );
      ids.add(check.id);
      checks.push(check);
    }
    if (result.check_runs.length < 100)
      return exactCheck(checks, run, host.repository);
  }
  throw new Error(
    "Published entry check inventory exceeds its complete-read bound",
  );
}

function exactCheck(checks, run, repository) {
  const url = `https://github.com/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
  // Actions may replace details_url with the check's own provider URL. Its
  // exact external execution identity still binds the original native receipt.
  const matches = checks.filter(
    (check) =>
      check.name === "check" &&
      (check.details_url === url ||
        (check.details_url ===
          `https://github.com/${repository}/runs/${check.id}` &&
          check.external_id?.endsWith(`:${run.id}:${run.run_attempt}`))),
  );
  if (!matches.length) return null;
  const values = matches.map((check) => {
    const parsed =
      /^buildchain:(attempt-[0-9a-f]{64}):([1-9][0-9]*):([1-9][0-9]*)$/u.exec(
        check.external_id || "",
      );
    if (
      !parsed ||
      Number(parsed[2]) !== run.id ||
      Number(parsed[3]) !== run.run_attempt ||
      check.head_sha !== run.head_sha ||
      check.status !== "completed" ||
      !["success", "failure"].includes(check.conclusion) ||
      check.app?.slug !== "github-actions"
    )
      throw new Error(
        "Published entry check does not bind its exact native attempt",
      );
    return {
      attempt: parsed[1],
      outcome: check.conclusion,
      summary: check.output?.summary || "",
    };
  });
  if (values.some((value) => recordDigest(value) !== recordDigest(values[0])))
    throw new Error("Published entry checks disagree about the same execution");
  return {
    ...values[0],
    ids: matches.map(({ id }) => id).sort((a, b) => a - b),
  };
}
