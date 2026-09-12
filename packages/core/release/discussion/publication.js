import { decodeRecord } from "./envelope.js";
import { discussionTransport } from "../../providers/github/discussions/transport.js";
import path from "node:path";
import fs from "node:fs";
import { openReleaseSession, RELEASE_NODES } from "./session.js";
import { releaseCheckpoints, retainRecoveryMaterials } from "./checkpoints.js";
import { promoteReleaseCandidate } from "../promote-candidate/transaction.js";

export async function publicationNodes(request, graphql) {
  if (!request["resume-discussion-id"])
    return [
      ...RELEASE_NODES,
      ...(request["standalone-binary-distribution"]
        ? ["binary-distribution"]
        : []),
    ];
  const discussion = await discussionTransport(graphql).get(
    request["resume-discussion-id"],
  );
  const intent = decodeRecord(discussion.body);
  if (
    intent?.repository !== request.repository ||
    intent.key !== request.version
  )
    throw new Error("Discussion recovery cannot change the release intent");
  return intent.expectedNodes;
}

export async function publishWithDiscussion(
  request,
  {
    octokit,
    mutationOctokit,
    actor,
    runId,
    attempt,
    runtime,
    workspace,
    runtimeRoot,
    observe = () => {},
  },
) {
  const journal = await openReleaseSession({
    graphql: octokit.graphql,
    repository: request.repository,
    key: request.version,
    source: { version: request.version },
    expectedNodes: await publicationNodes(request, octokit.graphql),
    runtime,
    attempt,
    discussionId: request["resume-discussion-id"],
    recover: Boolean(
      request["resume-discussion-id"] ||
      request["publish-transaction-override"],
    ),
  });
  const retained = releaseCheckpoints({
    session: journal.session,
    store: journal.store,
    octokit,
  });
  const readerFile = path.join(
    runtimeRoot,
    "dist/readers/release-discussion.cjs",
  );
  const locator = {
    "discussion-id": journal.session.discussion.id,
    "discussion-url": journal.session.discussion.url,
  };
  observe(locator);
  const locatorPath = path.join(
    workspace,
    ".buildchain/release-tail/buildchain.release-transaction.json",
  );
  fs.mkdirSync(path.dirname(locatorPath), { recursive: true });
  fs.writeFileSync(
    locatorPath,
    JSON.stringify({
      schema: "buildchain.release-locator/v1",
      repository: request.repository,
      version: request.version,
      intent: journal.session.intent.id,
      discussionId: journal.session.discussion.id,
    }),
  );
  const execution = {
    ...request,
    discussionCheckpoint: retained.checkpoint,
    discussionReaderPath: readerFile,
    discussionLocatorPath: locatorPath,
    retainRecoveryMaterials: async () =>
      retained.checkpoint(
        "qualification",
        await retainRecoveryMaterials(
          { request, workspace, readerFile },
          retained.materials,
        ),
      ),
  };
  const result = await promoteReleaseCandidate(execution, {
    octokit,
    mutationOctokit,
    actor,
    runId,
    observeNode: journal.observe,
    observe: (outputs) => observe({ ...outputs, ...locator }),
  });
  return {
    ...result,
    discussion: journal.session.discussion,
    outputs: { ...result.outputs, ...locator },
  };
}
