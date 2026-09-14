import { readBusinessAttempt } from "../../workflow/attempt/reader.js";

// The current provider timeline survives webhook/runtime handoff. Compare it
// with this candidate's lifetime so an earlier removal cannot cancel recovery.
export function githubPipelineQueueExit(graphql, repository) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository || ""))
    throw new Error("Invalid pipeline queue repository");
  const [owner, repo] = repository.split("/");
  return async (current, candidate) => {
    if (!candidate || candidate.terminal) return null;
    const started = Date.parse(candidate.enqueuedAt);
    if (!Number.isFinite(started))
      throw new Error("Queue candidate timestamp is missing");
    const number = current.intent.source.pullRequest;
    const result = await graphql(
      `
        query ($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              number
              headRefOid
              baseRefName
              state
              mergeQueueEntry {
                id
              }
              timelineItems(
                last: 2
                itemTypes: [
                  ADDED_TO_MERGE_QUEUE_EVENT
                  REMOVED_FROM_MERGE_QUEUE_EVENT
                ]
              ) {
                nodes {
                  __typename
                  ... on AddedToMergeQueueEvent {
                    id
                    createdAt
                  }
                  ... on RemovedFromMergeQueueEvent {
                    id
                    createdAt
                  }
                }
              }
            }
          }
        }
      `,
      { owner, repo, number },
    );
    const pr = result.repository?.pullRequest;
    if (
      pr?.number !== number ||
      pr.headRefOid !== current.generation.source.commit ||
      pr.baseRefName !== current.intent.source.targetBranch
    )
      throw new Error("Queue exit source identity changed; reobserve");
    if (pr.state !== "OPEN" || pr.mergeQueueEntry) return null;
    const nodes = pr.timelineItems?.nodes;
    if (!Array.isArray(nodes) || nodes.length > 2)
      throw new Error("Queue exit timeline readback is missing or ambiguous");
    const event = nodes.at(-1);
    if (event?.__typename !== "RemovedFromMergeQueueEvent") return null;
    const queued = nodes.at(-2);
    if (queued?.__typename !== "AddedToMergeQueueEvent")
      throw new Error("Queue removal has no matching admission readback");
    const removed = Date.parse(event.createdAt);
    const entered = Date.parse(queued.createdAt);
    if (
      !event.id ||
      !queued.id ||
      !Number.isFinite(removed) ||
      !Number.isFinite(entered) ||
      entered > removed
    )
      throw new Error("Queue removal identity or timestamp is missing");
    return entered > started ? event : null;
  };
}

// Branch/terminal notifications wake existing intents only. They cannot create
// historical releases or infer an execution request from an untracked old PR.
export function githubPipelineEvents(request, journal, repository) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository || ""))
    throw new Error("Invalid pipeline event repository");
  const base = `/repos/${repository}`;
  async function list(url) {
    const rows = [];
    for (let page = 1; page <= 100; page++) {
      const entries = await request(
        `${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      if (!Array.isArray(entries))
        throw new Error("Invalid pipeline PR event readback");
      rows.push(...entries);
      if (entries.length < 100) return rows;
    }
    throw new Error("Pipeline PR event readback exceeds its bound");
  }
  async function branch(branch, commit = "") {
    if (
      !/^(?:dev|alpha|release|publish-gate)\/[A-Za-z0-9/._-]+$/u.test(
        branch || "",
      ) ||
      branch.includes("..")
    )
      throw new Error("Invalid pipeline branch event");
    const pulls = await list(
      `${base}/pulls?state=open&base=${encodeURIComponent(branch)}`,
    );
    if (commit) {
      if (!/^[0-9a-f]{40}$/u.test(commit))
        throw new Error("Branch wake requires exact source commit");
      pulls.push(...(await list(`${base}/commits/${commit}/pulls`)));
    }
    const result = new Set();
    for (const number of [
      ...new Set(
        pulls.filter((pr) => pr.base?.ref === branch).map((pr) => pr.number),
      ),
    ]) {
      const retained = await journal.lookup(repository, number, branch);
      if (!retained) continue;
      const state = readBusinessAttempt(retained.snapshot);
      if (state.attempt) result.add(state.attempt);
    }
    return [...result];
  }
  return { branch };
}
