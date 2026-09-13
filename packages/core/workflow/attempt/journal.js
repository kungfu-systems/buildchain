import {
  canonicalJson,
  recordDigest,
} from "../../release/discussion/envelope.js";
import { readBusinessAttempt } from "./reader.js";

export const ATTEMPT_JOURNAL = "buildchain.attempt-journal/v1";

export function journalSnapshot(intent, records) {
  readBusinessAttempt({ intent, records });
  const body = { schema: ATTEMPT_JOURNAL, intent, records };
  return { ...body, root: recordDigest(body) };
}

export function validateJournal(snapshot, intent) {
  if (
    snapshot?.schema !== ATTEMPT_JOURNAL ||
    canonicalJson(snapshot.intent) !== canonicalJson(intent) ||
    canonicalJson(snapshot) !==
      canonicalJson(journalSnapshot(intent, snapshot.records))
  )
    throw new Error("Attempt journal identity or content root drift");
  return snapshot;
}

// The provider atomically appends a single-parent Git commit with force=false.
// Discussion is a projection of these admitted bytes, never a competing writer.
export function atomicAttemptJournal(provider, intent) {
  readBusinessAttempt({ intent, records: [] });
  async function read() {
    const loaded = await provider.read(intent);
    const snapshot = loaded
      ? validateJournal(loaded.snapshot, intent)
      : journalSnapshot(intent, []);
    return {
      commit: loaded?.commit || "",
      snapshot,
      ...readBusinessAttempt(snapshot),
    };
  }
  async function append(record, expectedHead) {
    const observed = await read();
    if (observed.snapshot.records.some((event) => event.id === record.id)) {
      // Never acknowledge an invalid body merely because its ID was copied.
      const prior = observed.snapshot.records.find(
        (event) => event.id === record.id,
      );
      if (canonicalJson(prior) !== canonicalJson(record))
        throw new Error("Conflicting attempt record bytes");
      return observed;
    }
    if ((observed.head || "") !== expectedHead)
      throw new Error("Stale attempt head; reobserve before writing");
    if (record.node === "attempt") {
      if (record.predecessor !== (observed.attempt || ""))
        throw new Error("Recovery must succeed the current attempt");
    } else if (record.attempt !== observed.attempt)
      throw new Error("A superseded attempt cannot append new results");
    const snapshot = journalSnapshot(intent, [
      ...observed.snapshot.records,
      record,
    ]);
    let failure;
    try {
      await provider.append({
        intent,
        snapshot,
        expectedCommit: observed.commit,
      });
    } catch (error) {
      failure = error;
    }
    // A lost response can follow a committed append. Reconcile the immutable
    // record in live history; never retry the old parent with force=true.
    const result = await read();
    if (
      !result.snapshot.records.some(
        (event) => canonicalJson(event) === canonicalJson(record),
      )
    )
      throw (
        failure || new Error("Attempt append missing from provider readback")
      );
    return result;
  }
  return { read, append };
}
