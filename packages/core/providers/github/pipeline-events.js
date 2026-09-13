import { readBusinessAttempt } from "../../workflow/attempt/reader.js";

// Branch/terminal notifications wake existing intents only. They cannot create
// historical releases or infer an execution request from an untracked old PR.
export function githubPipelineEvents(request, journal, repository) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository || ""))
    throw new Error("Invalid pipeline event repository");
  const base = `/repos/${repository}`;
  async function list(url) {
    const rows = [];
    for (let page = 1; page <= 100; page++) {
      const entries = await request(
        `${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      if (!Array.isArray(entries))
        throw new Error("Invalid pipeline PR event readback");
      rows.push(...entries);
      if (entries.length < 100) return rows;
    }
    throw new Error("Pipeline PR event readback exceeds its bound");
  }
  async function branch(branch, commit = "") {
    if (
      !/^(?:dev|alpha|release|publish-gate)\/[A-Za-z0-9/._-]+$/u.test(
        branch || "",
      ) ||
      branch.includes("..")
    )
      throw new Error("Invalid pipeline branch event");
    const pulls = await list(
      `${base}/pulls?state=open&base=${encodeURIComponent(branch)}`,
    );
    if (commit) {
      if (!/^[0-9a-f]{40}$/u.test(commit))
        throw new Error("Branch wake requires exact source commit");
      pulls.push(...(await list(`${base}/commits/${commit}/pulls`)));
    }
    const result = new Set();
    for (const number of [
      ...new Set(
        pulls.filter((pr) => pr.base?.ref === branch).map((pr) => pr.number),
      ),
    ]) {
      const retained = await journal.lookup(repository, number, branch);
      if (!retained) continue;
      const state = readBusinessAttempt(retained.snapshot);
      if (state.attempt) result.add(state.attempt);
    }
    return [...result];
  }
  return { branch };
}
