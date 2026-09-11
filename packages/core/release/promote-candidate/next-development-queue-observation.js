export async function observeNextDevelopmentQueue({
  mutationOctokit,
  pull,
  headSha,
}) {
  const { node } = await mutationOctokit.graphql(
    `query BuildchainObserveQueuedPullRequest($id: ID!) {
      node(id: $id) { ... on PullRequest {
        id headRefOid baseRefName state merged mergeQueueEntry { id }
      } }
    }`,
    { id: pull.node_id },
  );
  if (
    node?.id !== pull.node_id ||
    node.headRefOid !== headSha ||
    (pull.base?.ref && node.baseRefName !== pull.base.ref) ||
    !["OPEN", "MERGED"].includes(node.state) ||
    node.merged !== (node.state === "MERGED")
  )
    throw new Error(
      "next-development queue readback cannot prove the exact open or merged pull request",
    );
  return node.merged || Boolean(node.mergeQueueEntry?.id);
}
