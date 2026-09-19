import { decodeRecord } from "./envelope.js";
import { collectDiscussionPages } from "../../providers/github/discussions/transport.js";

export function isAttemptRoot(record) {
  return (
    record?.node === "attempt" &&
    record.kind === "progress" &&
    record.status === "running" &&
    record.sequence === 0
  );
}

// Provider placement is checked before the pure reader reduces event semantics.
// Historical flat records retain their original representation; new writes always
// use roots and replies. An explicit intent organization makes placement strict.
export async function readDiscussionThreads(transport, session) {
  const top = await collectDiscussionPages((after) =>
    transport.comments(session.discussion.id, after),
  );
  const comments = [...top];
  for (const root of top) {
    if (root.replies?.totalCount === 0) continue;
    const replies = await collectDiscussionPages((after) =>
      transport.replies(root.id, after),
    );
    for (const reply of replies) {
      if (reply.replyTo?.id !== root.id)
        throw new Error(
          "Discussion reply parent differs from its queried thread",
        );
    }
    comments.push(...replies);
    if (Buffer.byteLength(JSON.stringify(comments)) > 32 * 1024 * 1024)
      throw new Error("Discussion threads exceed the complete-view byte bound");
  }
  const trusted = comments.filter(
    (comment) => comment.author?.id === session.writerId,
  );
  const records = new Map();
  for (const comment of trusted) {
    const record = decodeRecord(comment.body);
    if (!record) continue;
    if (comment.lastEditedAt)
      throw new Error(
        "A transaction record was edited; historical facts are no longer intact",
      );
    records.set(comment.id, record);
  }
  const roots = new Map();
  for (const comment of trusted) {
    const record = records.get(comment.id);
    if (!isAttemptRoot(record)) continue;
    if (comment.replyTo || roots.has(record.attempt))
      throw new Error("Ambiguous or nested Discussion attempt root");
    roots.set(record.attempt, comment);
  }
  for (const comment of trusted) {
    const record = records.get(comment.id);
    if (!record || isAttemptRoot(record)) continue;
    const root = roots.get(record.attempt);
    if (comment.replyTo) {
      if (!root || comment.replyTo.id !== root.id)
        throw new Error(
          "Transaction event is attached to a different attempt root",
        );
    } else if (session.intent.organization === "attempt-threads/v1") {
      throw new Error("Transaction event requires its attempt root reply");
    }
  }
  return { comments: trusted, records: [...records.values()], roots };
}

export function eventParent(state, record) {
  const root = state.roots.get(record.attempt);
  if (isAttemptRoot(record)) {
    if (root)
      throw new Error("Attempt root already exists with different content");
    return null;
  }
  if (!root)
    throw new Error("Open the attempt root before appending its events");
  return root.id;
}
