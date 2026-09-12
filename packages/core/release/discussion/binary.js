import { discussionTransport } from "../../providers/github/discussions/transport.js";
import { releaseDiscussionStore } from "./store.js";
import { createProgress, decodeRecord } from "./envelope.js";

// An independent distribution workflow joins the existing intent after resolving
// its public release locator. Capturing the attempt before execution keeps a late
// result on its original attempt when another workflow starts recovery.
export async function observeBinaryDistribution(
  { client, octokit, repository, tag, runtime, writer },
  effect,
) {
  const release = await client.release(tag);
  const assets = release.assets.filter(
    ({ name }) => name === "buildchain.release-transaction.json",
  );
  if (assets.length !== 1)
    throw new Error(
      "Binary distribution requires one release transaction locator",
    );
  const locator = JSON.parse(client.assetBytes(assets[0]));
  if (
    locator.schema !== "buildchain.release-locator/v1" ||
    locator.repository !== repository ||
    `v${locator.version}` !== tag
  )
    throw new Error("Binary transaction locator does not match its release");
  const transport = discussionTransport(octokit.graphql);
  const discussion = await transport.get(locator.discussionId);
  const intent = decodeRecord(discussion.body);
  if (
    intent?.id !== locator.intent ||
    intent.repository !== repository ||
    discussion.author?.login !== "github-actions[bot]"
  )
    throw new Error(
      "Binary transaction intent does not match the consumer workflow",
    );
  const store = releaseDiscussionStore(transport);
  const session = { discussion, intent, writerId: discussion.author.id };
  const state = await store.read(session);
  if (!state.attempt || !intent.expectedNodes.includes("binary-distribution"))
    throw new Error(
      "Binary distribution was not declared by this release intent",
    );
  const attemptRecord = state.records.find(
    (record) => record.attempt === state.attempt,
  );
  const sequence =
    Math.max(
      -1,
      ...state.records
        .filter(
          (record) =>
            record.kind === "progress" &&
            record.attempt === state.attempt &&
            record.node === "binary-distribution",
        )
        .map((record) => record.sequence),
    ) + 1;
  const record = (status, offset, payload = {}) =>
    store.append(
      session,
      createProgress({
        intent,
        runtime,
        writer,
        attempt: state.attempt,
        predecessor: attemptRecord.predecessor,
        node: "binary-distribution",
        status,
        sequence: sequence + offset,
        payload,
      }),
    );
  await record("running", 0);
  let result;
  try {
    result = await effect();
  } catch (error) {
    try {
      await record("failure", 1, {
        code: String(error.code || "execution-failed"),
      });
    } catch (recordError) {
      error.discussionRecordingError = recordError.message;
    }
    throw error;
  }
  await record("success", 1, { tag, assets: result.assets.length });
  return result;
}
