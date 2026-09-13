import { releaseDiscussionStore } from "../../release/discussion/store.js";
import { validateAttemptRecord } from "./records.js";
import { readBusinessAttempt } from "./reader.js";

// exclusive.run owns the repository/intent-wide writer scope, not merely this
// process. assertOwner rechecks the live provider fence before every mutation.
// No default mutex: an in-memory lock cannot serialize independent workflows.
export function businessAttemptStore(transport, exclusive, options = {}) {
  if (typeof exclusive?.run !== "function")
    throw new Error("Attempt writes require an exclusive provider writer");
  const journal = releaseDiscussionStore(transport, options);
  async function read(session) {
    const observed = await journal.read(session);
    return { ...observed, ...readBusinessAttempt(observed) };
  }
  async function scoped(intent, operation) {
    return exclusive.run(
      { repository: intent.repository, intent: intent.id },
      async (owner) => {
        if (typeof owner?.assertOwner !== "function")
          throw new Error("Missing live writer fence");
        await owner.assertOwner();
        return operation(owner);
      },
    );
  }
  async function initialize(request) {
    readBusinessAttempt({ intent: request.intent, records: [] });
    return scoped(request.intent, async (owner) => {
      const repository = await transport.repository(request.intent.repository);
      if (repository.id !== request.intent.source.repositoryId)
        throw new Error("Intent repository identity changed");
      const fenced = { ...transport };
      for (const name of ["create", "append"])
        fenced[name] = async (...args) => {
          await owner.assertOwner();
          return transport[name](...args);
        };
      return releaseDiscussionStore(fenced, options).initialize(request);
    });
  }
  async function append(session, record, expectedHead) {
    return scoped(session.intent, async (owner) => {
      validateAttemptRecord(record, session.intent);
      const observed = await read(session);
      const existing = observed.records.find((event) => event.id === record.id);
      if (existing) return observed;
      if ((observed.head || "") !== expectedHead)
        throw new Error("Stale attempt head; reobserve before writing");
      if (record.node === "attempt") {
        if (record.predecessor !== (observed.attempt || ""))
          throw new Error("Recovery must succeed the current attempt");
      } else if (record.attempt !== observed.attempt)
        throw new Error("A superseded attempt cannot append new results");
      readBusinessAttempt({
        intent: observed.intent,
        records: [...observed.records, record],
      });
      await owner.assertOwner();
      const fenced = {
        ...transport,
        append: async (...args) => {
          await owner.assertOwner();
          return transport.append(...args);
        },
      };
      await releaseDiscussionStore(fenced, options).append(session, record);
      const result = await read(session);
      if (result.head !== record.id)
        throw new Error("Attempt append readback has a conflicting writer");
      return result;
    });
  }
  return { initialize, read, append };
}
