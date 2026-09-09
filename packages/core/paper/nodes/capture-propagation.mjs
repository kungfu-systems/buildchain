import fs from "node:fs";
import path from "node:path";
import { getOctokit } from "@actions/github";
import { requireValue } from "../../runtime/action-process.mjs";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
import {
  planReleasePropagation,
  createReleasePropagationWork,
  verifyReleasePropagationWork,
} from "../../release/release-propagation.js";

export function validatePaperPropagationConfig(config) {
  const fields = [
    "schemaVersion",
    "contract",
    "sourceNode",
    "graph",
    "targets",
  ].sort();
  requireValue(
    config &&
      JSON.stringify(Object.keys(config).sort()) === JSON.stringify(fields) &&
      config.schemaVersion === 1 &&
      config.contract === "kungfu-buildchain-paper-release-propagation",
    "Paper propagation config must use the exact current contract",
  );
  requireValue(
    config.graph &&
      typeof config.graph === "object" &&
      !Array.isArray(config.graph),
    "Paper propagation graph must be an object",
  );
  requireValue(
    typeof config.sourceNode === "string" && Boolean(config.sourceNode),
    "Paper propagation sourceNode is required",
  );
  requireValue(
    Array.isArray(config.targets) &&
      config.targets.length > 0 &&
      config.targets.every(
        (x) => typeof x === "string" && /^[A-Za-z0-9._-]+$/.test(x),
      ),
    "Paper propagation targets must be non-empty canonical node ids",
  );
  requireValue(
    JSON.stringify([...new Set(config.targets)].sort()) ===
      JSON.stringify(config.targets),
    "Paper propagation targets must be sorted and unique",
  );
  return config;
}
export async function capturePaperPropagation(
  env,
  { github = getOctokit(env.GH_TOKEN), outputs = writeGitHubOutputs } = {},
) {
  const [owner, repo] = env.GITHUB_REPOSITORY.split("/");
  let response;
  try {
    response = await github.rest.repos.getContent({
      owner,
      repo,
      path: ".buildchain/release-propagation.json",
      ref: env.SOURCE_SHA,
    });
  } catch (error) {
    if (error.status === 404) {
      outputs({ configured: false });
      return;
    }
    throw error;
  }
  requireValue(
    response.data.type === "file" && response.data.encoding === "base64",
    "Paper propagation config is not a base64 repository file",
  );
  const config = validatePaperPropagationConfig(
    JSON.parse(Buffer.from(response.data.content, "base64").toString("utf8")),
  );
  const upstreamRelease = JSON.parse(
    fs.readFileSync(".buildchain/upstream-release.json", "utf8"),
  );
  const plan = planReleasePropagation({
    graph: config.graph,
    upstreamRelease,
    sourceNode: config.sourceNode,
  });
  fs.writeFileSync(
    ".buildchain/release-propagation-config.json",
    JSON.stringify(config, null, 2) + "\n",
  );
  fs.writeFileSync(
    ".buildchain/release-propagation-plan.json",
    JSON.stringify(plan, null, 2) + "\n",
  );
  for (const target of config.targets) {
    const rows = plan.targets.filter((entry) => entry.target === target);
    requireValue(
      rows.length === 1 && /^[0-9a-f]{64}$/.test(rows[0].propagationKey),
      "Configured propagation target is absent or ambiguous",
    );
    const selected = rows[0];
    const [targetOwner, targetRepo] = selected.repository.split("/");
    const commit = await github.rest.repos.getCommit({
      owner: targetOwner,
      repo: targetRepo,
      ref: selected.baseRef,
    });
    const work = createReleasePropagationWork({
      plan,
      target,
      expectedDownstreamBaseSha: commit.data.sha,
    });
    const directory = path.join(
      ".buildchain/release-propagation-work",
      selected.propagationKey,
    );
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "work.json"),
      JSON.stringify(work, null, 2) + "\n",
    );
    fs.writeFileSync(
      path.join(directory, "status.json"),
      JSON.stringify(verifyReleasePropagationWork(work), null, 2) + "\n",
    );
  }
  outputs({
    configured: true,
    "artifact-name": `paper-propagation-work-${env.PACKAGE_VERSION}-${env.SOURCE_SHA}`,
  });
}
