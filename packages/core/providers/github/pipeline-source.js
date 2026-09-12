import { bindConsumerSource } from "../../consumer/contract/identity.js";
import { normalInputs } from "../../consumer/contract/entries.js";
import { channelRoute } from "../../workflow/pipeline/events.js";
import { recordDigest } from "../../release/discussion/envelope.js";
import { validateGeneration } from "../../workflow/attempt/identity.js";

function exactSha(value) {
  if (!/^[0-9a-f]{40}$/u.test(value || ""))
    throw new Error("Pipeline source requires an exact Git commit");
  return value;
}

function pullRequestBinding(pr) {
  return {
    number: pr.number,
    state: pr.state,
    merged: pr.merged,
    mergeCommit: pr.merge_commit_sha,
    head: pr.head,
    base: pr.base,
    draft: pr.draft,
    labels: pr.labels,
    updatedAt: pr.updated_at,
  };
}

export function githubPipelineSource(request, repository) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository || ""))
    throw new Error("Invalid pipeline repository");
  const base = `/repos/${repository}`;
  async function source(commitInput, configPath) {
    const commit = exactSha(commitInput);
    const git = await request(`${base}/git/commits/${commit}`);
    const config = await request(
      `${base}/contents/${configPath}?ref=${commit}`,
    );
    if (
      config.type !== "file" ||
      config.encoding !== "base64" ||
      !Number.isSafeInteger(config.size) ||
      config.size < 1 ||
      config.size > 256_000 ||
      typeof config.content !== "string" ||
      config.content.length > 512_000
    )
      throw new Error("Pipeline TOML is missing or exceeds its byte bound");
    const bytes = Buffer.from(config.content, "base64");
    if (bytes.length !== config.size)
      throw new Error("Pipeline TOML size drift");
    return bindConsumerSource(
      {
        repository,
        commit,
        tree: exactSha(git.tree?.sha),
        configPath,
        configBlob: config.sha,
      },
      bytes,
    );
  }
  async function branchHead(branch) {
    if (
      !/^(?:dev|alpha|release|publish-gate)\/[A-Za-z0-9/._-]+$/u.test(
        branch || "",
      ) ||
      branch.includes("..")
    )
      throw new Error("Invalid protected branch");
    const pointer = await request(`${base}/git/ref/heads/${branch}`);
    if (pointer.object?.type !== "commit")
      throw new Error("Protected ref is not a commit");
    return exactSha(pointer.object.sha);
  }
  async function observe(pullRequest, inputs = {}) {
    if (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
      throw new Error("Pipeline requires an exact PR number");
    const { configPath } = normalInputs(inputs);
    const pr = await request(`${base}/pulls/${pullRequest}`);
    const repositoryInfo = await request(base);
    if (pr.number !== pullRequest || !repositoryInfo.node_id)
      throw new Error("Pipeline PR provider identity drift");
    // Read delivery policy from the protected base. A PR may change its own
    // product commands, but cannot lower review or grant itself a channel route.
    const baseCommit = await branchHead(pr.base?.ref);
    const protectedSource = await source(baseCommit, configPath);
    const route = channelRoute(protectedSource.plan, pr, repository);
    if (!route) {
      if (baseCommit !== (await branchHead(pr.base.ref)))
        throw new Error("Protected policy changed during route observation");
      return { eligible: false, reason: "channel-not-enabled" };
    }
    const admitted = await source(pr.head.sha, configPath);
    const again = await request(`${base}/pulls/${pullRequest}`);
    if (
      recordDigest(pullRequestBinding(pr)) !==
        recordDigest(pullRequestBinding(again)) ||
      baseCommit !== (await branchHead(pr.base.ref))
    )
      throw new Error("Pipeline source changed during observation; reobserve");
    return {
      eligible: true,
      repositoryId: repositoryInfo.node_id,
      route,
      plan: admitted.plan,
      protectedPlan: protectedSource.plan,
      protectedSource: protectedSource.identity,
      live: {
        pullRequest,
        observedHead: pr.head.sha,
        targetBranch: pr.base.ref,
        routeEnabled: true,
        source: admitted.identity,
        baseCommit,
        state: pr.state,
        merged: pr.merged === true,
        mergeCommit: pr.merge_commit_sha,
        draft: pr.draft === true,
        ready: pr.labels.some((label) => label.name === "ready"),
      },
    };
  }
  async function observeIntent(intent, generation, inputs = {}) {
    validateGeneration(generation, intent);
    if (intent.repository !== repository)
      throw new Error("Recorded intent repository drift");
    const number = intent.source.pullRequest;
    const pr = await request(`${base}/pulls/${number}`);
    const repositoryInfo = await request(base);
    if (
      repositoryInfo.node_id !== intent.source.repositoryId ||
      pr.number !== number ||
      pr.base?.repo?.full_name !== repository
    )
      throw new Error("Recorded pipeline intent provider identity drift");
    const sameHead =
      pr.head?.repo?.full_name === repository &&
      pr.head.sha === generation.source.commit;
    const live = {
      pullRequest: number,
      observedHead: exactSha(pr.head?.sha),
      targetBranch: pr.base.ref,
      state: pr.state,
      merged: pr.merged === true,
      mergeCommit: pr.merge_commit_sha,
      source: sameHead ? generation.source : null,
      baseCommit: null,
      ready: pr.labels.some((label) => label.name === "ready"),
      draft: pr.draft === true,
    };
    // Closing, updating or retargeting an admitted PR must remain recoverable
    // even when its new TOML is invalid, its old route disappeared or it is now a fork.
    if (
      pr.state !== "open" ||
      !sameHead ||
      pr.base.ref !== intent.source.targetBranch
    ) {
      const again = await request(`${base}/pulls/${number}`);
      if (
        recordDigest(pullRequestBinding(pr)) !==
        recordDigest(pullRequestBinding(again))
      )
        throw new Error("Recorded intent changed during terminal observation");
      return { eligible: true, cleanupOnly: true, live };
    }
    const observed = await observe(number, inputs);
    if (observed.eligible) return observed;
    return {
      eligible: true,
      cleanupOnly: true,
      live: {
        ...live,
        baseCommit: await branchHead(intent.source.targetBranch),
        routeEnabled: false,
      },
    };
  }
  return { observe, observeIntent, source, branchHead };
}
