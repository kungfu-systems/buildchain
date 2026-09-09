export async function resolveReleaseIntent({
  github,
  context,
  core,
  env = process.env,
}) {
  const defaults = {
    "production-release-approved": "false",
    "production-release-pr": "",
    "production-release-source": "",
    "production-release-reason": "not-a-main-release-push",
    "production-source-sha": context.sha,
  };
  for (const [name, value] of Object.entries(defaults))
    core.setOutput(name, value);

  const { enabled, eventName, eventAction, refName, requestedSourceSha } = releaseIntentEvent(env);
  if (requestedSourceSha) {
    return resolveExplicitProductionIntent({ requestedSourceSha, eventName, env, core });
  }
  const mainPush = eventName === "push" && refName === "main";
  const closedPullRequest =
    eventName === "pull_request" && eventAction === "closed";
  if (!enabled || (!mainPush && !closedPullRequest)) {
    await core.summary
      .addHeading("Buildchain production release PR intent")
      .addRaw(`- approved: \`false\`\n`)
      .addRaw(
        `- reason: \`${enabled ? "not-a-release-event" : "release-pr-publish-disabled"}\`\n`,
      )
      .write();
    core.setOutput(
      "production-release-reason",
      enabled ? "not-a-release-event" : "release-pr-publish-disabled",
    );
    return;
  }

  const requiredLabel = (env.PRODUCTION_RELEASE_LABEL || "").trim();
  const requiredHeadPrefix = (env.PRODUCTION_RELEASE_HEAD_PREFIX || "").trim();
  if (!requiredLabel) {
    throw new Error(
      "production-release-label must be non-empty when production-release-on-main is true",
    );
  }

  const { owner, repo } = context.repo;
  const fullName = `${owner}/${repo}`;
  const associated = closedPullRequest
    ? [context.payload.pull_request]
    : await github.paginate(
        github.rest.repos.listPullRequestsAssociatedWithCommit,
        {
          owner,
          repo,
          commit_sha: context.sha,
          per_page: 100,
        },
      );
  const candidates = associated.filter((pull) => {
    const labels = (pull.labels || []).map((label) => label.name);
    const sameRepoHead = pull.head?.repo?.full_name === fullName;
    const merged = Boolean(pull.merged_at);
    const mainBase = pull.base?.ref === "main";
    const hasLabel = labels.includes(requiredLabel);
    const headRef = pull.head?.ref || "";
    const headMatches =
      !requiredHeadPrefix || headRef.startsWith(requiredHeadPrefix);
    return merged && sameRepoHead && mainBase && hasLabel && headMatches;
  });

  if (candidates.length === 0) {
    core.setOutput("production-release-reason", "no-associated-release-pr");
    await core.summary
      .addHeading("Buildchain production release PR intent")
      .addRaw(`- approved: \`false\`\n`)
      .addRaw(`- reason: \`no-associated-release-pr\`\n`)
      .addRaw(`- required label: \`${requiredLabel}\`\n`)
      .addRaw(`- required head prefix: \`${requiredHeadPrefix || "(none)"}\`\n`)
      .write();
    return;
  }
  if (candidates.length > 1) {
    throw new Error(
      `multiple associated production release PRs matched ${context.sha}: ${candidates.map((pull) => `#${pull.number}`).join(", ")}`,
    );
  }

  const releasePull = candidates[0];
  const productionSourceSha = releasePull.merge_commit_sha || context.sha;
  if (!/^[0-9a-f]{40}$/i.test(productionSourceSha)) {
    throw new Error(
      `matching production release PR has invalid merge commit SHA: ${productionSourceSha || "(empty)"}`,
    );
  }
  core.setOutput("production-release-approved", "true");
  core.setOutput("production-release-pr", String(releasePull.number));
  core.setOutput("production-release-source", releasePull.head.ref || "");
  core.setOutput(
    "production-release-reason",
    closedPullRequest
      ? "closed-release-pr-merged"
      : "associated-release-pr-merged",
  );
  core.setOutput("production-source-sha", productionSourceSha);
  await core.summary
    .addHeading("Buildchain production release PR intent")
    .addRaw(`- approved: \`true\`\n`)
    .addRaw(`- release PR: #${releasePull.number}\n`)
    .addRaw(`- source branch: \`${releasePull.head.ref || ""}\`\n`)
    .addRaw(`- production source SHA: \`${productionSourceSha}\`\n`)
    .addRaw(`- required label: \`${requiredLabel}\`\n`)
    .addRaw(`- required head prefix: \`${requiredHeadPrefix || "(none)"}\`\n`)
    .write();
}

async function resolveExplicitProductionIntent({ requestedSourceSha, eventName, env, core }) {
    if (
      eventName !== "workflow_dispatch" ||
      env.PRODUCTION_APPROVED !== "true"
    ) {
      throw new Error(
        "production-source-sha is admitted only by an explicitly approved workflow_dispatch",
      );
    }
    if (!/^[0-9a-f]{40}$/.test(requestedSourceSha)) {
      throw new Error(
        "production-source-sha must be an exact 40-character Git SHA",
      );
    }
    core.setOutput("production-release-approved", "true");
    core.setOutput("production-release-source", "exact-reviewed-source");
    core.setOutput(
      "production-release-reason",
      "exact-reviewed-workflow-dispatch",
    );
    core.setOutput("production-source-sha", requestedSourceSha);
    await core.summary
      .addHeading("Buildchain exact production activation intent")
      .addRaw(`- approved: \`true\`\n`)
      .addRaw(`- source SHA: \`${requestedSourceSha}\`\n`)
      .addRaw(`- environment: \`${env.PRODUCTION_ENVIRONMENT}\`\n`)
      .write();
    return;
}

function releaseIntentEvent(env) {
  const enabled = env.PRODUCTION_RELEASE_ON_MAIN === "true";
  const eventName = env.EVENT_NAME || "";
  const eventAction = env.EVENT_ACTION || "";
  const refName = env.REF_NAME || "";
  const requestedSourceSha = (env.PRODUCTION_SOURCE_SHA || "")
    .trim()
    .toLowerCase();
  return { enabled, eventName, eventAction, refName, requestedSourceSha };
}
