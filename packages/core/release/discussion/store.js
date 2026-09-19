import { readDiscussionThreads, eventParent } from "./threads.js";
import { renderIntent, renderEvent } from "./presentation.js";
import { collectDiscussionPages } from "../../providers/github/discussions/transport.js";
import {
  canonicalJson,
  decodeRecord,
  encodeRecord,
  INTENT_SCHEMA,
} from "./envelope.js";
import { readReleaseDiscussion } from "./reader.js";

function assertDiscussion(discussion, intent, writerId) {
  if (
    discussion.repository.nameWithOwner.toLowerCase() !==
    intent.repository.toLowerCase()
  )
    throw new Error("Discussion belongs to a different consumer repository");
  if (discussion.author?.id !== writerId || discussion.lastEditedAt)
    throw new Error("Discussion intent has an untrusted author or was edited");
  const existing = decodeRecord(discussion.body);
  if (existing?.id !== intent.id || existing.schema !== INTENT_SCHEMA)
    throw new Error("Discussion contains a different release intent");
  if (
    canonicalJson(existing.expectedNodes) !==
      canonicalJson(intent.expectedNodes) ||
    canonicalJson(existing.source) !== canonicalJson(intent.source)
  )
    throw new Error("Release intent changed during recovery");
  return existing;
}

export function releaseDiscussionStore(
  transport,
  { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  async function observeAfterUnknown(readback, cause) {
    if (
      [401, 403].includes(cause.status) ||
      cause.errors?.some((error) =>
        ["FORBIDDEN", "UNAUTHORIZED"].includes(error.type),
      )
    )
      throw new Error(
        "Consumer workflow cannot write this Discussion; grant discussions: write and permit Announcements creation",
        { cause },
      );
    for (let attempt = 0; attempt < 4; attempt++) {
      const record = await readback();
      if (record) return record;
      if (attempt < 3) await sleep(250 * (attempt + 1));
    }
    throw new Error(
      "Discussion mutation outcome is unknown; retry by reading the same intent before any further write",
      { cause },
    );
  }
  async function initialize({
    intent,
    discussionId = "",
    category = "Announcements",
    dryRun = false,
  }) {
    if (dryRun) return { dryRun: true, intent };
    const repository = await transport.repository(intent.repository);
    const writerId = repository.viewer.id;
    if (discussionId) {
      const discussion = await transport.get(discussionId);
      const original = assertDiscussion(discussion, intent, writerId);
      return { discussion, intent: original, writerId };
    }
    const selected = repository.discussionCategories.nodes.filter(
      (entry) => entry.name === category,
    );
    if (selected.length !== 1)
      throw new Error(
        `Release Discussion category ${category} must exist exactly once`,
      );
    const find = async () => {
      const candidates = await collectDiscussionPages((after) =>
        transport.list(intent.repository, selected[0].id, after),
      );
      const matching = candidates.filter(
        (discussion) =>
          discussion.author?.id === writerId &&
          decodeRecord(discussion.body)?.id === intent.id,
      );
      if (matching.length > 1)
        throw new Error(
          "Multiple Discussions own this release intent; refusing ambiguous recovery",
        );
      if (matching.length) assertDiscussion(matching[0], intent, writerId);
      return matching[0];
    };
    let discussion = await find();
    if (!discussion) {
      try {
        discussion = await transport.create({
          repositoryId: repository.id,
          categoryId: selected[0].id,
          title: intent.source?.qualification
            ? `Buildchain qualification: ${intent.source.qualification}`
            : `Buildchain release: ${intent.key}`,
          body: encodeRecord(intent, renderIntent(intent)),
        });
      } catch (error) {
        discussion = await observeAfterUnknown(find, error);
      }
    }
    const original = assertDiscussion(discussion, intent, writerId);
    return { discussion, intent: original, writerId };
  }
  async function read(session) {
    const discussion = await transport.get(session.discussion.id);
    const intent = assertDiscussion(
      discussion,
      session.intent,
      session.writerId,
    );
    const threads = await readDiscussionThreads(transport, {
      ...session,
      intent,
      discussion,
    });
    return {
      discussion,
      ...threads,
      ...readReleaseDiscussion({
        body: discussion.body,
        records: threads.records,
      }),
    };
  }
  async function append(session, record) {
    if (session.dryRun) return { dryRun: true };
    let observed;
    const find = async () => {
      observed = await read(session);
      const existing = observed.comments.find(
        (comment) => decodeRecord(comment.body)?.id === record.id,
      );
      if (!existing)
        readReleaseDiscussion({
          body: observed.discussion.body,
          records: [...observed.records, record],
        });
      return existing;
    };
    const existing = await find();
    if (existing) return existing;
    const parent = eventParent(observed, record);
    const body = encodeRecord(
      record,
      renderEvent(record, session.intent, observed),
    );
    try {
      await transport.append(session.discussion.id, body, parent);
    } catch (error) {
      return observeAfterUnknown(find, error);
    }
    return observeAfterUnknown(
      find,
      new Error("Discussion append requires provider readback"),
    );
  }
  return { initialize, read, append };
}
