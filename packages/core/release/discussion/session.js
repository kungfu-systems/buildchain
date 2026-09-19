import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createIntent, createProgress } from "./envelope.js";
import { releaseDiscussionStore } from "./store.js";
import { discussionTransport } from "../../providers/github/discussions/transport.js";

export const RELEASE_NODES = [
  "qualification",
  "publication",
  "github-release",
  "next-development",
  "settlement",
];

export function selectedRecordRuntime(env) {
  const selection = JSON.parse(env.BUILDCHAIN_RUNTIME_SELECTION || "{}");
  const file = path.join(
    env.BUILDCHAIN_RUNTIME_ROOT || "",
    "dist/readers/release-discussion.cjs",
  );
  return {
    repository: selection.repository,
    sha: selection.sha,
    readerPath: "dist/readers/release-discussion.cjs",
    readerDigest: `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`,
  };
}

export async function openReleaseSession({
  graphql,
  repository,
  key,
  source,
  runtime,
  attempt,
  discussionId = "",
  predecessor = "",
  dryRun = false,
  recover = false,
  expectedNodes = RELEASE_NODES,
  onFailure = async () => {},
}) {
  const intent = createIntent({
    repository,
    key,
    source,
    runtime,
    expectedNodes,
  });
  const store = releaseDiscussionStore(discussionTransport(graphql));
  const session = await store.initialize({ intent, discussionId, dryRun });
  if (dryRun)
    return {
      session,
      observe: async (_node, effect) => effect(),
      record: async () => {},
      read: async () => ({ dryRun: true }),
    };
  const current = await store.read(session);
  const retained = current.records.find((event) => event.attempt === attempt);
  const prior =
    retained?.predecessor ??
    (predecessor || (recover ? current.attempt || "" : ""));
  if (
    current.attempt &&
    current.attempt !== attempt &&
    prior !== current.attempt
  )
    throw new Error(
      `Recovery requires predecessor ${current.attempt} in the same Discussion`,
    );
  session.attempt = attempt;
  session.predecessor = prior;
  session.runtime = runtime;
  const record = async (node, status, payload = {}, sequence = 0) =>
    store.append(
      session,
      createProgress({
        intent: session.intent,
        runtime,
        attempt,
        predecessor: prior,
        node,
        status,
        payload,
        sequence,
      }),
    );
  await record("attempt", "running");
  const observe = async (node, effect, summarize = () => ({})) => {
    await record(node, "running");
    let result;
    try {
      result = await effect();
    } catch (error) {
      // Preserve the original failure even when the diagnostic provider is down.
      try {
        await record(
          node,
          "failure",
          { code: String(error.code || "execution-failed") },
          1,
        );
        await onFailure(node, error);
      } catch (recordError) {
        error.discussionRecordingError = recordError.message;
      }
      throw error;
    }
    await record(node, "success", summarize(result), 1);
    return result;
  };
  return { session, store, observe, record, read: () => store.read(session) };
}
