import path from "node:path";
import fs from "node:fs";
import { openReleaseSession, RELEASE_NODES } from "./session.js";
import { releaseCheckpoints, retainRecoveryMaterials } from "./checkpoints.js";
import { promoteReleaseCandidate } from "../promote-candidate/transaction.js";

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
    expectedNodes: [
      ...RELEASE_NODES,
      ...(request["standalone-binary-distribution"]
        ? ["binary-distribution"]
        : []),
    ],
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
    sourceSha: request["source-sha"],
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
