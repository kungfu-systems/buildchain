export async function resolveReleaseIntent({ github, context, core, request }) {
  const defaults = {
    "production-release-approved": "false",
    "production-release-pr": "",
    "production-release-source": "",
    "production-release-reason": "not-a-main-release-push",
    "production-source-sha": context.sha,
  };
  for (const [name, value] of Object.entries(defaults))
    core.setOutput(name, value);

  const { enabled, eventName, eventAction, refName, requestedSourceSha } =
    releaseIntentEvent(request, context);
  if (requestedSourceSha) {
    return resolveExplicitProductionIntent({
      requestedSourceSha,
      eventName,
      request,
      core,
    });
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

  const requiredLabel = (request["production-release-label"] || "").trim();
  const requiredHeadPrefix = (
    request["production-release-head-prefix"] || ""
  ).trim();
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

async function resolveExplicitProductionIntent({
  requestedSourceSha,
  eventName,
  request,
  core,
}) {
  if (
    eventName !== "workflow_dispatch" ||
    request["production-approved"] !== true
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
    .addRaw(`- environment: \`${request["production-environment"]}\`\n`)
    .write();
  return;
}

function releaseIntentEvent(request, context) {
  const enabled = request["production-release-on-main"] === true;
  const eventName = context.eventName || "";
  const eventAction = context.payload?.action || "";
  const refName = String(context.ref || "").replace(
    /^refs\/(?:heads|tags)\//u,
    "",
  );
  const requestedSourceSha = (request["production-source-sha"] || "")
    .trim()
    .toLowerCase();
  return { enabled, eventName, eventAction, refName, requestedSourceSha };
}
