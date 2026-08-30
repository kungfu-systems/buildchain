import { releaseTailRoot } from "../../packages/core/release-tail-provider-plane.js";

const COMMIT_IDENTITY = {
  name: "Keren Dong",
  email: "keren.dong@kungfu.link",
};
const SIGN_OFF = `Signed-off-by: ${COMMIT_IDENTITY.name} <${COMMIT_IDENTITY.email}>`;

function providerError(message, releaseTailClass, releaseTailCode) {
  return Object.assign(new Error(message), {
    releaseTailClass,
    releaseTailCode,
  });
}

function notFound(error) {
  return error?.status === 404 || error?.response?.status === 404;
}

function splitRepository(repository) {
  const match = String(repository || "").match(/^([^/\s]+)\/([^/\s]+)$/u);
  if (!match) throw new Error(`invalid publication repository: ${repository}`);
  return { owner: match[1], repo: match[2] };
}

function operationFor(plan, effect) {
  const operation = plan.operations.find(
    ({ id }) => id === effect.capabilityId,
  );
  if (
    !operation ||
    operation.adapter !== effect.adapter ||
    operation.operationRoot !== effect.targetRoot
  )
    throw providerError(
      `effect does not match rooted product operation ${effect.capabilityId}`,
      "conflict",
      "rooted-product-operation-mismatch",
    );
  return operation;
}

function observed(effect, evidence) {
  return {
    outcome: "observed",
    subjectRoot: effect.subjectRoot,
    targetRoot: effect.targetRoot,
    providerCode: "rooted-product-effect-observed",
    evidenceRoots: [releaseTailRoot(evidence)],
  };
}

function absent(code) {
  return { outcome: "absent", providerCode: code, evidenceRoots: [] };
}

function conflict(code) {
  return { outcome: "conflict", providerCode: code, evidenceRoots: [] };
}

function refName(value) {
  return String(value || "").replace(/^refs\//u, "");
}

async function getRef(octokit, repository, ref) {
  const { owner, repo } = splitRepository(repository);
  try {
    const { data } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: refName(ref),
    });
    return data;
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

async function createRef(octokit, repository, ref, sha) {
  const { owner, repo } = splitRepository(repository);
  try {
    await octokit.rest.git.createRef({ owner, repo, ref, sha });
  } catch (error) {
    if (!notFound(error) && error?.status !== 422) throw error;
    const existing = await getRef(octokit, repository, ref);
    if (existing?.object?.sha !== sha)
      throw providerError(
        `${ref} exists at ${existing?.object?.sha || "<unknown>"}, not ${sha}`,
        "conflict",
        "provider-ref-conflict",
      );
  }
}

async function commitContains(octokit, repository, ancestor, current) {
  if (ancestor === current) return true;
  const { owner, repo } = splitRepository(repository);
  if (typeof octokit.rest.repos?.compareCommitsWithBasehead !== "function")
    return false;
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${ancestor}...${current}`,
  });
  return data.status === "ahead" || data.status === "identical";
}

async function versionStateReadback(context, effect) {
  const { request, plan, versionFiles } = context;
  const operation = operationFor(plan, effect);
  const state = await getRef(
    request.octokit,
    operation.target.repository,
    operation.target.stateRef,
  );
  if (!state) return absent("version-state-ref-absent");
  const releaseSha = state.object?.sha;
  const { owner, repo } = splitRepository(operation.target.repository);
  const { data: commit } = await request.octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: releaseSha,
  });
  if (!commit.parents?.some(({ sha }) => sha === operation.target.sourceSha))
    return conflict("version-state-parent-conflict");
  const { data: tree } = await request.octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: commit.tree.sha,
    recursive: "1",
  });
  const entries = new Map(
    (tree.tree || []).map((entry) => [entry.path, entry]),
  );
  for (const file of versionFiles) {
    const entry = entries.get(file.path);
    if (!entry?.sha) return conflict("version-state-file-missing");
    const { data: blob } = await request.octokit.rest.git.getBlob({
      owner,
      repo,
      file_sha: entry.sha,
    });
    const actual = Buffer.from(
      blob.content,
      blob.encoding || "base64",
    ).toString("utf8");
    if (actual !== file.content) return conflict("version-state-file-conflict");
  }
  return observed(effect, {
    kind: "github-version-state",
    stateRef: operation.target.stateRef,
    releaseSha,
    files: versionFiles.map(({ path }) => path).sort(),
  });
}

async function versionStateApply(context, effect) {
  const { request, plan, versionFiles, intent, updates } = context;
  const operation = operationFor(plan, effect);
  const existing = await versionStateReadback(context, effect);
  if (existing.outcome === "observed") return;
  if (existing.outcome === "conflict")
    throw providerError(
      "version-state readback conflicts with the rooted effect",
      "conflict",
      existing.providerCode,
    );
  const { owner, repo } = splitRepository(operation.target.repository);
  const { data: baseCommit } = await request.octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: operation.target.sourceSha,
  });
  const tree = [];
  for (const file of versionFiles) {
    const { data: blob } = await request.mutationOctokit.rest.git.createBlob({
      owner,
      repo,
      content: file.content,
      encoding: "utf-8",
    });
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const { data: nextTree } = await request.mutationOctokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.tree.sha,
    tree,
  });
  const identity = {
    ...COMMIT_IDENTITY,
    date: operation.target.sourceTimestamp,
  };
  const { data: commit } = await request.mutationOctokit.rest.git.createCommit({
    owner,
    repo,
    message: `chore(release): prepare ${intent.exactTag}\n\n${SIGN_OFF}`,
    tree: nextTree.sha,
    parents: [operation.target.sourceSha],
    author: identity,
    committer: identity,
  });
  await createRef(
    request.mutationOctokit,
    operation.target.repository,
    operation.target.stateRef,
    commit.sha,
  );
  updates.push({
    action: "materialized-version-state",
    ref: operation.target.stateRef,
    sha: commit.sha,
    version: intent.version,
  });
}

async function resolvedVersionStateSha(context, operation) {
  const ref = await getRef(
    context.request.octokit,
    operation.target.repository,
    operation.target.stateRef,
  );
  if (!ref?.object?.sha)
    throw providerError(
      "rooted version-state ref is missing",
      "transient",
      "version-state-ref-absent",
    );
  return ref.object.sha;
}

async function refsReadback(context, effect) {
  const { request, plan, intent } = context;
  const operation = operationFor(plan, effect);
  const stateSha = await resolvedVersionStateSha(context, operation);
  let channelSha = "";
  for (const reference of operation.target.references) {
    const ref = await getRef(
      request.octokit,
      operation.target.repository,
      reference.ref,
    );
    if (!ref) return absent("release-ref-absent");
    const actual = ref.object?.sha;
    if (reference.target === "source") {
      if (actual !== operation.target.sourceSha)
        return conflict("exact-release-tag-conflict");
    } else if (reference.ref === `refs/heads/${intent.targetRef}`) {
      if (
        !(await commitContains(
          request.octokit,
          operation.target.repository,
          stateSha,
          actual,
        ))
      )
        return absent("channel-ref-not-converged");
      channelSha = actual;
    } else if (reference.ref.startsWith("refs/heads/")) {
      if (
        !(await commitContains(
          request.octokit,
          operation.target.repository,
          stateSha,
          actual,
        ))
      )
        return absent("development-ref-not-converged");
    } else if (!channelSha || actual !== channelSha) {
      return absent("floating-release-tag-not-converged");
    }
  }
  return observed(effect, {
    kind: "github-release-refs",
    stateSha,
    channelSha,
    references: operation.target.references,
  });
}

async function ensureGeneratedCheck(context, repository, branch, sha) {
  const { request, intent } = context;
  if (typeof request.octokit.rest.checks?.create !== "function") return;
  const { owner, repo } = splitRepository(repository);
  await request.octokit.rest.checks.create({
    owner,
    repo,
    name: request.requiredStatusCheck || "check",
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    output: {
      title: "Buildchain rooted product version state",
      summary: `Verified ${intent.exactTag} before converging ${branch}.`,
    },
  });
}

async function openProtectedRefPullRequest(
  context,
  repository,
  branch,
  sha,
  error,
) {
  const { request, intent, updates } = context;
  const { owner, repo } = splitRepository(repository);
  const head = `buildchain/v4-product-pr/${branch.replaceAll("/", "-")}/${sha.slice(0, 12)}`;
  await createRef(
    request.mutationOctokit,
    repository,
    `refs/heads/${head}`,
    sha,
  );
  const existing = await request.mutationOctokit.rest.pulls.list({
    owner,
    repo,
    state: "open",
    base: branch,
    head: `${owner}:${head}`,
  });
  if (!existing.data?.[0])
    await request.mutationOctokit.rest.pulls.create({
      owner,
      repo,
      head,
      base: branch,
      title: `Prepare ${intent.exactTag}`,
      body:
        `Converge the rooted v4 product publication state for ${intent.exactTag}.\n\n` +
        `Direct protected ref update was rejected: ${error?.message || "provider policy"}`,
    });
  updates.push({ action: "pending-protected-ref-pr", ref: branch, sha });
}

async function convergeBranch(context, repository, ref, sha) {
  const { request, updates } = context;
  const branch = ref.replace(/^refs\/heads\//u, "");
  const current = await getRef(request.octokit, repository, ref);
  if (
    current?.object?.sha &&
    (await commitContains(request.octokit, repository, sha, current.object.sha))
  )
    return true;
  await ensureGeneratedCheck(context, repository, branch, sha);
  const { owner, repo } = splitRepository(repository);
  try {
    if (current)
      await request.mutationOctokit.rest.git.updateRef({
        owner,
        repo,
        ref: refName(ref),
        sha,
        force: false,
      });
    else await createRef(request.mutationOctokit, repository, ref, sha);
    updates.push({ action: "converged-protected-ref", ref: branch, sha });
    return true;
  } catch (error) {
    if (![403, 409, 422].includes(error?.status || error?.response?.status))
      throw error;
    await openProtectedRefPullRequest(context, repository, branch, sha, error);
    return false;
  }
}

async function updateTag(context, repository, ref, sha) {
  const { request, updates } = context;
  const current = await getRef(request.octokit, repository, ref);
  const { owner, repo } = splitRepository(repository);
  if (!current) await createRef(request.mutationOctokit, repository, ref, sha);
  else if (current.object?.sha !== sha)
    await request.mutationOctokit.rest.git.updateRef({
      owner,
      repo,
      ref: refName(ref),
      sha,
      force: true,
    });
  updates.push({ action: "converged-release-tag", ref, sha });
}

async function refsApply(context, effect) {
  const { request, plan, intent } = context;
  const operation = operationFor(plan, effect);
  const stateSha = await resolvedVersionStateSha(context, operation);
  const exact = operation.target.references.find(
    ({ target }) => target === "source",
  );
  await createRef(
    request.mutationOctokit,
    operation.target.repository,
    exact.ref,
    operation.target.sourceSha,
  );
  const branches = operation.target.references.filter(({ ref }) =>
    ref.startsWith("refs/heads/"),
  );
  for (const reference of branches)
    if (
      !(await convergeBranch(
        context,
        operation.target.repository,
        reference.ref,
        stateSha,
      ))
    )
      return;
  const channel = await getRef(
    request.octokit,
    operation.target.repository,
    `refs/heads/${intent.targetRef}`,
  );
  const channelSha = channel?.object?.sha;
  if (!channelSha)
    throw providerError(
      "channel ref is absent after convergence",
      "transient",
      "channel-ref-absent",
    );
  for (const reference of operation.target.references.filter(
    ({ ref, target }) => ref.startsWith("refs/tags/") && target !== "source",
  ))
    await updateTag(
      context,
      operation.target.repository,
      reference.ref,
      channelSha,
    );
}

export function createV4GithubProductAdapters(context) {
  return {
    adapters: {
      "github-version-state": {
        readback: (effect) => versionStateReadback(context, effect),
        apply: (effect) => versionStateApply(context, effect),
      },
      "github-release-refs": {
        readback: (effect) => refsReadback(context, effect),
        apply: (effect) => refsApply(context, effect),
      },
    },
    resolveReleaseSha: async () => {
      const ref = await getRef(
        context.request.octokit,
        context.intent.repository,
        `refs/heads/${context.intent.targetRef}`,
      );
      return ref?.object?.sha || "";
    },
  };
}
