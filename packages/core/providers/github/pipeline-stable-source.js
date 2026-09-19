import { createHash } from "node:crypto";
import { recordDigest } from "../../release/discussion/envelope.js";
import { verifyPipelinePublicationPlan } from "../../publication/pipeline/plan.js";
import { compareDevelopmentVersions } from "../../publication/publication-development.js";
import { githubPipelineSource } from "./pipeline-source.js";
import { githubPipelineVersion } from "./pipeline-version.js";
import { normalInputs } from "../../consumer/contract/entries.js";

const SHA = /^[0-9a-f]{40}$/u;
const STABLE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function publishedRelease(value, repository, tag, prerelease) {
  if (
    !Number.isSafeInteger(value?.id) ||
    value.id < 1 ||
    value.tag_name !== tag ||
    value.draft !== false ||
    value.prerelease !== prerelease ||
    value.html_url !== `https://github.com/${repository}/releases/tag/${tag}` ||
    typeof value.published_at !== "string" ||
    !Number.isFinite(Date.parse(value.published_at))
  )
    throw new Error(
      "Stable eligibility requires the exact public release identity",
    );
  return {
    id: value.id,
    tag,
    publishedAt: new Date(value.published_at).toISOString(),
  };
}

async function exactTag(get, tag) {
  const pointer = await get(`/git/ref/tags/${encodeURIComponent(tag)}`);
  if (
    pointer.ref !== `refs/tags/${tag}` ||
    !SHA.test(pointer.object?.sha || "")
  )
    throw new Error("Stable release tag identity changed");
  let object = pointer.object;
  for (let depth = 0; object.type === "tag" && depth < 4; depth++) {
    const annotated = await get(`/git/tags/${object.sha}`);
    if (annotated.sha !== object.sha || !SHA.test(annotated.object?.sha || ""))
      throw new Error("Stable annotated tag identity changed");
    object = annotated.object;
  }
  if (object.type !== "commit" || !SHA.test(object.sha))
    throw new Error(
      "Stable release tag must resolve to a bounded exact commit",
    );
  return { object: pointer.object.sha, commit: object.sha };
}

async function releases(get) {
  const result = [],
    ids = new Set();
  for (let page = 1; page <= 20; page++) {
    const values = await get(`/releases?per_page=100&page=${page}`);
    if (!Array.isArray(values) || values.length > 100)
      throw new Error("Stable release inventory is incomplete");
    for (const value of values) {
      if (!Number.isSafeInteger(value.id) || value.id < 1 || ids.has(value.id))
        throw new Error(
          "Stable release inventory has duplicate or invalid identities",
        );
      ids.add(value.id);
      result.push(value);
    }
    if (values.length < 100) return result;
  }
  throw new Error("Stable release inventory exceeds its complete-read bound");
}

function predecessors(values, plan) {
  const older = [],
    tags = new Set(),
    major = plan.version.split(".")[0];
  for (const value of values) {
    const match = STABLE.exec(value.tag_name || "");
    if (!match || match[1] !== major || value.draft === true) continue;
    const release = publishedRelease(
      value,
      plan.source.repository,
      value.tag_name,
      false,
    );
    if (tags.has(release.tag))
      throw new Error("Stable release inventory repeats an exact tag");
    tags.add(release.tag);
    const order = compareDevelopmentVersions(
      release.tag.slice(1),
      plan.version,
    );
    if (order > 0)
      throw new Error("A newer stable product has already been published");
    // The current version can already exist during recovery of the same
    // transaction. The effect journal separately verifies its exact bytes.
    if (order < 0) older.push(release);
  }
  older.sort((a, b) =>
    compareDevelopmentVersions(b.tag.slice(1), a.tag.slice(1)),
  );
  const comparison = older[0] || null;
  const latest =
    [...older].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0] ||
    null;
  return { comparison, latest };
}

async function treeFiles(get, commitSha) {
  const commit = await get(`/git/commits/${commitSha}`);
  if (commit.sha !== commitSha || !SHA.test(commit.tree?.sha || ""))
    throw new Error("Stable source commit or tree identity changed");
  const tree = await get(`/git/trees/${commit.tree.sha}?recursive=1`);
  if (
    tree.sha !== commit.tree.sha ||
    tree.truncated !== false ||
    !Array.isArray(tree.tree) ||
    tree.tree.length > 100_000
  )
    throw new Error("Stable product difference requires a complete Git tree");
  const files = new Map(),
    paths = new Set();
  for (const entry of tree.tree) {
    if (
      typeof entry.path !== "string" ||
      !entry.path ||
      entry.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      paths.has(entry.path) ||
      !SHA.test(entry.sha || "")
    )
      throw new Error("Stable product tree has an ambiguous or invalid path");
    paths.add(entry.path);
    const modes = {
      tree: ["040000"],
      blob: ["100644", "100755", "120000"],
      commit: ["160000"],
    };
    if (!modes[entry.type]?.includes(entry.mode))
      throw new Error(
        "Stable product tree has an unsupported entry type or mode",
      );
    if (entry.type !== "tree")
      files.set(entry.path, {
        sha: entry.sha,
        mode: entry.mode,
        type: entry.type,
      });
  }
  return { tree: commit.tree.sha, files };
}

async function impactDocument(get, files, pathname, version) {
  const entry = files.get(pathname);
  if (entry?.type !== "blob" || !["100644", "100755"].includes(entry.mode))
    throw new Error(
      "Stable impact must be a regular file in the exact Alpha tree",
    );
  const blob = await get(`/git/blobs/${entry.sha}`);
  if (
    blob.sha !== entry.sha ||
    blob.encoding !== "base64" ||
    !Number.isSafeInteger(blob.size) ||
    blob.size < 1 ||
    blob.size > 1024 * 1024 ||
    typeof blob.content !== "string" ||
    blob.content.length > 2 * 1024 * 1024
  )
    throw new Error("Stable impact exceeds its exact Git blob boundary");
  const bytes = Buffer.from(blob.content, "base64");
  const sha = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (bytes.length !== blob.size || sha !== entry.sha)
    throw new Error("Stable impact Git blob bytes changed");
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (value?.release?.version !== version)
    throw new Error("Stable impact does not belong to the exact Alpha version");
  return {
    path: pathname,
    blob: sha,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    value,
  };
}

function changedPaths(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(
      (pathname) =>
        recordDigest(before.get(pathname) || null) !==
        recordDigest(after.get(pathname) || null),
    )
    .sort();
}

function stableSourceReader(plan, host) {
  verifyPipelinePublicationPlan(plan);
  const repository = plan.source.repository;
  if (
    host.repository !== repository ||
    !/^[\w.-]+\/[\w.-]+$/u.test(repository) ||
    plan.channel !== "stable" ||
    !plan.stablePolicy ||
    !/^\d+\.\d+\.\d+-alpha\.\d+$/u.test(plan.candidateVersion) ||
    plan.candidateVersion.split("-alpha.")[0] !== plan.version
  )
    throw new Error(
      "Stable source collection requires its exact repository and Alpha candidate plan",
    );
  const base = `/repos/${repository}`;
  normalInputs({ "config-path": plan.source.configPath });
  const request = (endpoint, options = {}) => {
    if (
      !endpoint.startsWith(`${base}/`) ||
      (options.method && options.method !== "GET")
    )
      throw new Error(
        "Stable source collection cannot mutate or cross repositories",
      );
    return host.request(endpoint, options);
  };
  const get = (pathname) => request(`${base}${pathname}`);
  return { repository, request, get };
}

async function recheckStableSources(
  get,
  { plan, pointer, release, selected, prior, latest },
) {
  const repository = plan.source.repository,
    tag = `v${plan.candidateVersion}`;
  const repeatedRelease = publishedRelease(
    await get(`/releases/tags/${tag}`),
    repository,
    tag,
    true,
  );
  if (
    recordDigest(await exactTag(get, tag)) !== recordDigest(pointer) ||
    recordDigest(repeatedRelease) !== recordDigest(release) ||
    recordDigest(predecessors(await releases(get), plan)) !==
      recordDigest(selected) ||
    (prior &&
      recordDigest(await exactTag(get, selected.comparison.tag)) !==
        recordDigest(prior)) ||
    (latest &&
      recordDigest(await exactTag(get, selected.latest.tag)) !==
        recordDigest(latest))
  )
    throw new Error("Stable source facts changed during provider readback");
}

// Read-only provider facts. This result intentionally contains no successful
// canary or release authorization; those require independent qualification.
export async function readPipelineStableSource(plan, host) {
  const { repository, request, get } = stableSourceReader(plan, host);
  const tag = `v${plan.candidateVersion}`;
  const pointer = await exactTag(get, tag);
  if (pointer.commit !== plan.intentSource.commit)
    throw new Error("Published Alpha differs from the exact channel PR source");
  const release = publishedRelease(
    await get(`/releases/tags/${tag}`),
    repository,
    tag,
    true,
  );
  const candidate = await githubPipelineSource(request, repository).source(
    pointer.commit,
    plan.source.configPath,
  );
  if (
    recordDigest(candidate.identity) !== recordDigest(plan.intentSource) ||
    recordDigest(candidate.plan) !== plan.contractRoot ||
    recordDigest(candidate.plan.stable) !== recordDigest(plan.stablePolicy) ||
    recordDigest(candidate.plan.version) !== recordDigest(plan.versionPolicy)
  )
    throw new Error(
      "Published Alpha source or product policy differs from the admitted plan",
    );
  const version = await githubPipelineVersion(request, repository).inspect(
    candidate.identity,
    candidate.plan.version,
  );
  if (version.version !== plan.candidateVersion)
    throw new Error(
      "Published Alpha version documents disagree with its exact tag",
    );
  const selected = predecessors(await releases(get), plan);
  const prior = selected.comparison
    ? await exactTag(get, selected.comparison.tag)
    : null;
  if ((prior?.commit || null) !== plan.previousChannelCommit)
    throw new Error(
      "Stable comparison differs from the retained published channel",
    );
  const current = await treeFiles(get, pointer.commit);
  if (current.tree !== candidate.identity.tree)
    throw new Error(
      "Alpha tree changed between independent source observations",
    );
  const config = current.files.get(candidate.identity.configPath);
  if (
    config?.type !== "blob" ||
    !["100644", "100755"].includes(config.mode) ||
    config.sha !== candidate.identity.configBlob
  )
    throw new Error(
      "Alpha configuration is not the exact blob in its complete tree",
    );
  const previous = prior
    ? await treeFiles(get, prior.commit)
    : { files: new Map() };
  const impact = await impactDocument(
    get,
    current.files,
    plan.stablePolicy.impact_file,
    plan.candidateVersion,
  );
  const latest =
    selected.latest &&
    (selected.latest.tag === selected.comparison.tag
      ? prior
      : await exactTag(get, selected.latest.tag));
  await recheckStableSources(get, {
    plan,
    pointer,
    release,
    selected,
    prior,
    latest,
  });
  const body = {
    schema: "buildchain.pipeline-stable-source/v1",
    planRoot: plan.root,
    source: candidate.identity,
    contractRoot: plan.contractRoot,
    candidate: { ...release, sha: pointer.commit, tree: current.tree },
    previousStable: selected.latest
      ? { ...selected.latest, sha: latest.commit }
      : null,
    comparisonStable: selected.comparison
      ? { ...selected.comparison, sha: prior.commit, tree: previous.tree }
      : null,
    impact,
    changedPaths: changedPaths(previous.files, current.files),
  };
  return { ...body, root: recordDigest(body) };
}
