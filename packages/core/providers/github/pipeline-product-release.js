import { createHash } from "node:crypto";
import { pipelineProductPayload } from "./pipeline-product-payload.js";

const sha256 = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function githubPipelineProductRelease({
  github,
  request,
  repository,
  plan,
  qualified,
  documents,
  directory,
  evidence = [],
}) {
  const [owner, repo] = repository.split("/");
  const prefix = `/repos/${repository}`;
  const marker = `Buildchain release transaction ${documents.transaction.transactionRoot}`;
  const payload = pipelineProductPayload({
    qualified,
    documents,
    directory,
    evidence,
  });
  async function tag() {
    const value = await request(
      `${prefix}/git/ref/tags/${encodeURIComponent(plan.tag)}`,
      { allow404: true },
    );
    if (!value) return { state: "absent" };
    let object = value.object;
    for (let depth = 0; object.type === "tag" && depth < 4; depth++)
      object = (await request(`${prefix}/git/tags/${object.sha}`)).object;
    if (object.type !== "commit")
      throw new Error("Exact release tag does not resolve to a commit");
    return {
      state: "present",
      commit: object.sha,
      ref: value.ref,
      objectSha: value.object.sha,
    };
  }
  async function release(create = false) {
    const observedTag = await tag();
    if (observedTag.commit !== qualified.source.commit)
      throw new Error("Release requires the exact immutable publication tag");
    let value = await findRelease();
    if (!value && create) {
      try {
        await github.rest.repos.createRelease({
          owner,
          repo,
          tag_name: plan.tag,
          target_commitish: qualified.source.commit,
          name: plan.tag,
          body: marker,
          draft: true,
          prerelease: plan.channel === "alpha",
          make_latest: "false",
        });
      } catch (error) {
        value = await findRelease();
        if (!value) throw error;
      }
      value = await findRelease();
      if (!value)
        throw new Error("Release creation lacks exact provider readback");
    }
    if (
      value &&
      (value.tag_name !== plan.tag ||
        value.body !== marker ||
        value.prerelease !== (plan.channel === "alpha"))
    )
      throw new Error(
        "Existing GitHub Release belongs to a different immutable transaction",
      );
    return value;
  }
  const findRelease = () => findPipelineRelease(github, owner, repo, plan.tag);
  async function asset(effect) {
    const published = await release();
    if (!published) return { state: "absent" };
    const assets = await github.paginate(github.rest.repos.listReleaseAssets, {
      owner,
      repo,
      release_id: published.id,
      per_page: 100,
    });
    const matches = assets.filter((entry) => entry.name === effect.name);
    if (!matches.length) return { state: "absent" };
    if (matches.length !== 1 || matches[0].size > 256 * 1024 * 1024)
      throw new Error(
        "Release asset identity is ambiguous or exceeds its bound",
      );
    const bytes = Buffer.from(
      (
        await github.rest.repos.getReleaseAsset({
          owner,
          repo,
          asset_id: matches[0].id,
          headers: { accept: "application/octet-stream" },
        })
      ).data,
    );
    return {
      state: "present",
      id: matches[0].id,
      releaseId: published.id,
      size: bytes.length,
      digest: sha256(bytes),
    };
  }
  return {
    async observe(effect) {
      if (effect.kind === "exact-tag") return tag();
      if (effect.kind === "release-asset") return asset(effect);
      if (effect.kind === "release-visibility") {
        const value = await release();
        return value && !value.draft
          ? {
              state: "present",
              id: value.id,
              tag: value.tag_name,
              prerelease: value.prerelease,
            }
          : { state: "absent" };
      }
      throw new Error("Unsupported GitHub product publication operation");
    },
    matches(effect, observed) {
      if (observed.state !== "present") return false;
      if (effect.kind === "exact-tag") return observed.commit === effect.commit;
      if (effect.kind === "release-asset") {
        const bytes = payload(effect);
        return (
          observed.digest === sha256(bytes) && observed.size === bytes.length
        );
      }
      return (
        effect.kind === "release-visibility" &&
        observed.tag === effect.tag &&
        observed.prerelease === effect.prerelease
      );
    },
    async apply(effect) {
      if (effect.kind === "exact-tag")
        return request(`${prefix}/git/refs`, {
          method: "POST",
          body: { ref: `refs/tags/${effect.tag}`, sha: effect.commit },
        });
      const value = await release(true);
      if (effect.kind === "release-asset")
        return github.rest.repos.uploadReleaseAsset({
          owner,
          repo,
          release_id: value.id,
          name: effect.name,
          data: payload(effect),
          headers: { "content-type": "application/octet-stream" },
        });
      if (effect.kind === "release-visibility")
        return github.rest.repos.updateRelease({
          owner,
          repo,
          release_id: value.id,
          draft: false,
          make_latest: "false",
        });
      throw new Error("Unsupported GitHub product publication operation");
    },
  };
}

async function findPipelineRelease(github, owner, repo, tag) {
  let pages = 0;
  const values = await github.paginate(
    github.rest.repos.listReleases,
    { owner, repo, per_page: 100 },
    (response) => {
      if (++pages > 100)
        throw new Error("Release inventory exceeds its bounded readback");
      return response.data.filter((entry) => entry.tag_name === tag);
    },
  );
  if (values.length > 1)
    throw new Error("Exact release tag has multiple provider releases");
  return values[0];
}
