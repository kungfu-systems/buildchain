const encodeRef = (ref) => ref.split("/").map(encodeURIComponent).join("/");
export async function ensureCandidateSourceLock({
  api,
  owner,
  repo,
  ref,
  candidateSha,
  targetRef,
}) {
  const current = await api(
    `/repos/${owner}/${repo}/git/ref/heads/${encodeRef(ref)}`,
    { allow404: true },
  );
  if (!targetRef) {
    if (!current) {
      return api(`/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${ref}`, sha: candidateSha },
      });
    }
    if (current.object.sha !== candidateSha) {
      throw new Error(
        `source-lock branch ${ref} already points to ${current.object.sha}, not ${candidateSha}`,
      );
    }
    return current;
  }

  const candidateCommit = await api(
    `/repos/${owner}/${repo}/git/commits/${candidateSha}`,
  );
  let sourceSha = current?.object?.sha || candidateSha;
  if (sourceSha !== candidateSha) {
    const sourceCommit = await api(
      `/repos/${owner}/${repo}/git/commits/${sourceSha}`,
    );
    if (sourceCommit.tree?.sha !== candidateCommit.tree?.sha) {
      throw new Error(
        `source-lock branch ${ref} no longer preserves candidate ${candidateSha} tree`,
      );
    }
    const candidateLineage = await api(
      `/repos/${owner}/${repo}/compare/${candidateSha}...${sourceSha}`,
    );
    if (!["ahead", "identical"].includes(candidateLineage.status)) {
      throw new Error(
        `source-lock branch ${ref} no longer descends from candidate ${candidateSha}`,
      );
    }
  }

  const target = await api(
    `/repos/${owner}/${repo}/git/ref/heads/${encodeRef(targetRef)}`,
  );
  const targetSha = target.object?.sha || "";
  const targetLineage = await api(
    `/repos/${owner}/${repo}/compare/${targetSha}...${sourceSha}`,
  );
  if (["ahead", "identical"].includes(targetLineage.status)) {
    if (current) return current;
    return api(`/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${ref}`, sha: candidateSha },
    });
  }

  const identity = {
    name: "Buildchain Patrol",
    email: "buildchain-patrol@kungfu.link",
  };
  const reconciliation = await api(`/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: {
      message: [
        "chore(buildchain): reconcile stable source-lock ancestry",
        "",
        `Preserve the exact candidate tree from ${candidateSha} while admitting ${targetRef} at ${targetSha}.`,
        "",
        "Signed-off-by: Buildchain Patrol <buildchain-patrol@kungfu.link>",
      ].join("\n"),
      tree: candidateCommit.tree.sha,
      parents: [sourceSha, targetSha],
      author: identity,
      committer: identity,
    },
  });
  sourceSha = reconciliation.sha;
  if (!current) {
    return api(`/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${ref}`, sha: sourceSha },
    });
  }
  return api(`/repos/${owner}/${repo}/git/refs/heads/${encodeRef(ref)}`, {
    method: "PATCH",
    body: { sha: sourceSha, force: false },
  });
}
