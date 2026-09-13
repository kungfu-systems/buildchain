// Immutable lookup pointers are derived from admitted journal commits. The
// canonical intent journal must contain the selected root before a pointer can
// resolve; an orphan commit or pointer cannot create attempt authority.
export function githubAttemptIndex(request, journal, repository) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository || ""))
    throw new Error("Invalid attempt lookup repository");
  const base = `/repos/${repository}`;
  function ref(attempt) {
    if (!/^attempt-[0-9a-f]{64}$/u.test(attempt || ""))
      throw new Error("Invalid business attempt selector");
    return `buildchain/attempt-index/${attempt}`;
  }
  function root(snapshot, attempt) {
    const roots = snapshot.records.filter(
      (record) => record.attempt === attempt && record.node === "attempt",
    );
    if (roots.length !== 1)
      throw new Error("Lookup does not identify one admitted attempt root");
    return roots[0];
  }
  async function resolve(attempt) {
    const pointer = await request(`${base}/git/ref/heads/${ref(attempt)}`, {
      allow404: true,
    });
    if (!pointer) throw new Error("Business attempt lookup is not retained");
    const indexed = await journal.readCommit(repository, pointer.object?.sha);
    const selected = root(indexed.snapshot, attempt);
    const current = await journal.read(indexed.snapshot.intent);
    if (!current || root(current.snapshot, attempt).id !== selected.id)
      throw new Error(
        "Lookup attempt is absent from the authoritative journal",
      );
    return { ...current, selectedAttempt: attempt };
  }
  async function retain(intent, attempt) {
    if (intent.repository !== repository)
      throw new Error("Attempt lookup repository drift");
    const current = await journal.read(intent);
    if (!current) throw new Error("Cannot index an unadmitted attempt");
    const expected = root(current.snapshot, attempt);
    let failure;
    try {
      await request(`${base}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${ref(attempt)}`, sha: current.commit },
      });
    } catch (error) {
      failure = error;
    }
    try {
      const result = await resolve(attempt);
      if (root(result.snapshot, attempt).id !== expected.id)
        throw new Error("Conflicting business attempt lookup");
      return result;
    } catch (error) {
      throw failure || error;
    }
  }
  return { retain, resolve };
}
