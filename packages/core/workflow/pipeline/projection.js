import { releaseDiscussionStore } from "../../release/discussion/store.js";
import { discussionTransport } from "../../providers/github/discussions/transport.js";

// Copy committed journal records into their Discussion for human navigation.
// A lagging, unavailable or duplicated projection never supplies write authority.
export function pipelineProjection(
  graphql,
  transport = discussionTransport(graphql),
) {
  const store = releaseDiscussionStore(transport);
  return async (session) => {
    const observed = await session.journal.read();
    const target = await store.initialize({ intent: session.intent });
    const prior = await store.read(target);
    const known = new Set(prior.records.map((record) => record.id));
    for (const record of observed.snapshot.records)
      if (!known.has(record.id)) await store.append(target, record);
    return { url: target.discussion.url, journalHead: observed.head };
  };
}
