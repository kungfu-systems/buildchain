import { createHash } from "node:crypto";
import { recordDigest } from "../../release/discussion/envelope.js";
import {
  materializePipelineVersion,
  readPipelineVersion,
} from "../../publication/pipeline/version.js";
import { verifyPipelinePublicationPlan } from "../../publication/pipeline/plan.js";

function blobBytes(value, sha) {
  if (
    value.encoding !== "base64" ||
    value.size > 4 * 1024 * 1024 ||
    typeof value.content !== "string"
  )
    throw new Error("Version material requires a bounded Git blob");
  const bytes = Buffer.from(value.content, "base64");
  const digest = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (bytes.length !== value.size || digest !== sha || value.sha !== sha)
    throw new Error("Version material blob identity drift");
  return bytes.toString("utf8");
}

export function githubPipelineVersion(request, repository) {
  const base = `/repos/${repository}`;
  const post = (url, body) => request(url, { method: "POST", body });
  async function inspect(source, policy) {
    if (source.repository !== repository)
      throw new Error("Version material repository mismatch");
    const commit = await request(`${base}/git/commits/${source.commit}`);
    if (commit.sha !== source.commit || commit.tree?.sha !== source.tree)
      throw new Error("Version material source tree drift");
    const tree = await request(`${base}/git/trees/${source.tree}?recursive=1`);
    if (tree.truncated || tree.sha !== source.tree || !Array.isArray(tree.tree))
      throw new Error("Version material requires a complete source tree");
    const files = {},
      entries = {};
    for (const file of [
      ...policy.files,
      ...(policy.derived_files || []).map((path) => ({ path })),
    ]) {
      if (Object.hasOwn(files, file.path)) continue;
      const found = tree.tree.filter((entry) => entry.path === file.path);
      if (
        found.length !== 1 ||
        found[0].type !== "blob" ||
        !["100644", "100755"].includes(found[0].mode)
      )
        throw new Error("Version material must be a tracked regular file");
      const entry = found[0];
      entries[file.path] = entry;
      files[file.path] = blobBytes(
        await request(`${base}/git/blobs/${entry.sha}`),
        entry.sha,
      );
    }
    return {
      commit,
      files,
      entries,
      version: readPipelineVersion(policy, files),
      sourceTimestamp: commit.committer.date,
    };
  }
  async function materialize(plan) {
    verifyPipelinePublicationPlan(plan);
    const input = await inspect(plan.source, plan.versionPolicy);
    if (input.version !== plan.candidateVersion)
      throw new Error("Version material changed after planning");
    const material = materializePipelineVersion(
      plan.versionPolicy,
      input.files,
      plan.version,
    );
    let source = plan.source;
    if (material.changes.length)
      source = await createMaterializedSource(plan, input, material);
    const body = {
      schema: "buildchain.pipeline-version-materialization/v1",
      planRoot: plan.root,
      protectedSource: plan.source,
      source,
      material,
    };
    return { ...body, root: recordDigest(body) };
  }
  async function materializeDevelopment(plan) {
    const input = await inspect(plan.source, plan.versionPolicy);
    const material = materializePipelineVersion(
      plan.versionPolicy,
      input.files,
      plan.version,
    );
    const branch = `feature/buildchain-next/${plan.root.slice(7)}`;
    const source = material.changes.length
      ? await createMaterializedSource(plan, input, material, `heads/${branch}`)
      : plan.source;
    const body = {
      schema: "buildchain.pipeline-development-materialization/v1",
      transitionRoot: plan.root,
      protectedSource: plan.source,
      source,
      branch,
      material,
    };
    return { ...body, root: recordDigest(body) };
  }
  async function createMaterializedSource(plan, input, material, targetRef) {
    const changes = material.changes.map(({ path, content }) => ({
      path,
      content,
      mode: input.entries[path].mode,
      type: "blob",
    }));
    const tree = await post(`${base}/git/trees`, {
      base_tree: plan.source.tree,
      tree: changes,
    });
    const identity = {
      name: "Buildchain automation",
      email: "noreply@github.com",
      date: plan.sourceTimestamp,
    };
    const parents = [plan.source.commit];
    // Preserve the prior published version overlay as real Git ancestry. The
    // resulting tree still changes only the current protected version fields;
    // no provider force-update is needed for the next stable floating channel.
    if (
      plan.previousChannelCommit &&
      plan.previousChannelCommit !== plan.source.commit
    ) {
      if (!/^[0-9a-f]{40}$/u.test(plan.previousChannelCommit))
        throw new Error(
          "Version overlay parent must be an exact prior channel commit",
        );
      const previous = await request(
        `${base}/git/commits/${plan.previousChannelCommit}`,
      );
      if (previous.sha !== plan.previousChannelCommit)
        throw new Error("Prior version overlay commit changed");
      parents.push(previous.sha);
    }
    const created = await post(`${base}/git/commits`, {
      message: `chore(release): materialize ${plan.version}\n\nBuildchain-Plan: ${plan.root}\nSigned-off-by: Buildchain automation <noreply@github.com>`,
      tree: tree.sha,
      parents,
      author: identity,
      committer: identity,
    });
    const commit = await request(`${base}/git/commits/${created.sha}`);
    if (
      commit.tree?.sha !== tree.sha ||
      recordDigest(commit.parents?.map(({ sha }) => sha)) !==
        recordDigest(parents)
    )
      throw new Error("Materialized version commit readback mismatch");
    const source = { ...plan.source, commit: commit.sha, tree: tree.sha };
    const verified = await inspect(source, plan.versionPolicy);
    if (verified.version !== plan.version)
      throw new Error("Version material did not retain the planned version");
    const expectedFiles = {
      ...input.files,
      ...Object.fromEntries(
        material.changes.map(({ path, content }) => [path, content]),
      ),
    };
    if (recordDigest(verified.files) !== recordDigest(expectedFiles))
      throw new Error(
        "Version material changed document bytes beyond the planned fields",
      );
    const comparison = await request(
      `${base}/compare/${plan.source.commit}...${commit.sha}`,
    );
    const paths = comparison.files?.map((file) => file.filename).sort();
    if (
      comparison.status !== "ahead" ||
      (parents.length === 1 && comparison.total_commits !== 1) ||
      recordDigest(paths) !==
        recordDigest(material.changes.map(({ path }) => path).sort()) ||
      comparison.files.some((file) => file.status !== "modified")
    )
      throw new Error(
        "Version material changed paths outside the declared version fields",
      );
    const ref =
      targetRef || `heads/buildchain/publication-source/${plan.root.slice(7)}`;
    try {
      await post(`${base}/git/refs`, { ref: `refs/${ref}`, sha: commit.sha });
    } catch (error) {
      const observed = await request(`${base}/git/ref/${ref}`);
      if (observed.object?.sha !== commit.sha) throw error;
    }
    const observed = await request(`${base}/git/ref/${ref}`);
    if (observed.object?.sha !== commit.sha)
      throw new Error("Version material ref readback mismatch");
    return source;
  }
  return { inspect, materialize, materializeDevelopment };
}
