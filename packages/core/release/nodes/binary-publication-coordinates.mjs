import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  command,
  requireValue,
  runOperation,
} from "../../runtime/action-process.mjs";
export function validateSelection(env) {
  const runId = env.INPUT_RUN_ID || "",
    tag = env.INPUT_RELEASE_TAG || "",
    runtime = (env.INPUT_BUILDCHAIN_REF || "").toLowerCase();
  requireValue(
    /^[1-9][0-9]*$/u.test(runId),
    "Binary release publication requires an exact evidence run id",
  );
  const match = /^v([0-9]+)\.([0-9]+)\.[0-9]+(-alpha\.[0-9]+)?$/u.exec(tag);
  requireValue(
    match,
    "Binary release publication requires an exact semver tag",
  );
  requireValue(
    /^[0-9a-f]{40}$/u.test(runtime),
    "buildchain-ref must be an exact commit SHA",
  );
  requireValue(
    runtime === (env.GITHUB_SHA || "").toLowerCase(),
    "buildchain-ref must equal the exact workflow source SHA",
  );
  return {
    runId,
    tag,
    runtime,
    targetRef: `${match[3] ? "alpha" : "release"}/v${match[1]}/v${match[1]}.${match[2]}`,
  };
}
export function resolve(env, execute = command) {
  const { runId, tag, runtime, targetRef } = validateSelection(env);
  const options = { stdio: ["ignore", "pipe", "inherit"] };
  const endpoint = `repos/${env.GITHUB_REPOSITORY}/commits/${encodeURIComponent(tag)}`;
  const source = execute(
    "gh",
    ["api", endpoint, "--jq", ".sha"],
    options,
  ).trim();
  requireValue(
    /^[0-9a-f]{40}$/u.test(source),
    "Release tag did not resolve to an exact commit",
  );
  const observed = execute(
    "gh",
    ["api", endpoint, "--jq", ".sha"],
    options,
  ).trim();
  requireValue(
    source === observed,
    "Release tag moved while resolving publication coordinates",
  );
  execute(
    "gh",
    ["release", "view", tag, "--repo", env.GITHUB_REPOSITORY],
    options,
  );
  return {
    "buildchain-ref": runtime,
    "evidence-run-id": runId,
    "release-tag": tag,
    "source-sha": source,
    "target-ref": targetRef,
    "publication-version": tag.slice(1),
  };
}
function outputs(env) {
  const result = resolve(env);
  fs.appendFileSync(
    env.GITHUB_OUTPUT,
    Object.entries(result)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(""),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runOperation({ resolve: outputs });
