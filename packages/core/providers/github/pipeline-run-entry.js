import { createHash } from "node:crypto";
import {
  PIPELINE_ENTRY,
  RECOVERY_ENTRY,
  consumerWorkflows,
} from "../../consumer/contract/entries.js";

export function pipelineRunEntry(run) {
  const definitions = (run.referenced_workflows || []).filter((item) =>
    [PIPELINE_ENTRY, RECOVERY_ENTRY].some((entry) =>
      item.path?.startsWith(`kungfu-systems/buildchain/${entry}@`),
    ),
  );
  if (
    definitions.length !== 1 ||
    !/^[0-9a-f]{40}$/u.test(definitions[0].sha || "")
  )
    throw new Error(
      "Build provider run has no unique exact pipeline or recovery entry",
    );
  const definition = definitions[0];
  const recovery = definition.path.startsWith(
    `kungfu-systems/buildchain/${RECOVERY_ENTRY}@`,
  );
  const caller = `.github/workflows/${recovery ? "buildchain-recover" : "buildchain"}.yml`;
  const channel = definition.path
    .split("@")
    .at(-1)
    .replace(/^refs\/tags\//u, "");
  if (
    !["v4", "v4-alpha"].includes(channel) ||
    run.path?.split("@")[0] !== caller ||
    (recovery
      ? run.event !== "workflow_dispatch"
      : ![
          "pull_request",
          "repository_dispatch",
          "pull_request_review",
          "merge_group",
        ].includes(run.event))
  )
    throw new Error(
      "Build run did not enter through its trusted published consumer workflow",
    );
  return { definition, channel, caller, recovery };
}

// Entry presence and a matching job name alone are insufficient: an altered
// caller could add a lookalike job beside a failed reusable-workflow call.
export async function readPipelineCaller(run, configPath, request, repository) {
  const entry = pipelineRunEntry(run);
  if (
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository ||
    !/^[0-9a-f]{40}$/u.test(run.head_sha || "")
  )
    throw new Error("Pipeline execution crossed a repository or fork boundary");
  const file = await request(
    `/repos/${repository}/contents/${entry.caller}?ref=${run.head_sha}`,
  );
  if (
    file.type !== "file" ||
    file.encoding !== "base64" ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > 64000 ||
    typeof file.content !== "string" ||
    file.content.length > 128000
  )
    throw new Error("Pipeline caller workflow is absent or exceeds its bound");
  const bytes = Buffer.from(file.content, "base64");
  const blob = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (
    bytes.length !== file.size ||
    blob !== file.sha ||
    bytes.toString("utf8") !==
      consumerWorkflows(entry.channel, configPath)[entry.caller]
  )
    throw new Error(
      "Pipeline caller differs from the trusted minimal workflow contract",
    );
  return { commit: run.head_sha, path: entry.caller, blob };
}
