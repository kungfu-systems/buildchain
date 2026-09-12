import { createHash } from "node:crypto";

export function materialDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// Draft release assets retain immutable recovery bytes outside the source Git
// object database. Only the Discussion record selects a committed manifest.
export function discussionMaterials({ octokit, repository, intentId }) {
  const [owner, repo] = repository.split("/");
  const tag = `buildchain-records/${intentId.replace("sha256:", "")}`;
  const repos = octokit.rest.repos;
  let retainedArchive;
  async function findArchive() {
    let pages = 0;
    const releases = await octokit.paginate(
      repos.listReleases,
      { owner, repo, per_page: 100 },
      (response) => {
        if (++pages > 100)
          throw new Error("Material archive pagination exceeded its bound");
        return response.data.filter((release) => release.tag_name === tag);
      },
    );
    const matches = releases.filter((release) => release.tag_name === tag);
    if (matches.length > 1)
      throw new Error("Ambiguous transaction material archive");
    return matches[0];
  }
  async function archive() {
    if (retainedArchive) return retainedArchive;
    let release = await findArchive();
    if (!release) {
      try {
        release = (
          await repos.createRelease({
            owner,
            repo,
            tag_name: tag,
            // Storage archives use the repository default; candidate identity is
            // retained in the material manifest, never in a storage Git ref.
            name: `Buildchain transaction materials ${intentId}`,
            body: "Immutable recovery material. The associated Discussion owns transaction state.",
            draft: true,
            prerelease: true,
          })
        ).data;
      } catch (error) {
        release = await findArchive();
        if (!release)
          throw new Error("Material archive creation outcome is unknown", {
            cause: error,
          });
      }
    }
    if (!release.draft || release.tag_name !== tag)
      throw new Error("Transaction material archive identity mismatch");
    retainedArchive = release;
    return release;
  }
  async function read(handle) {
    const response = await repos.getReleaseAsset({
      owner,
      repo,
      asset_id: handle.id,
      headers: { accept: "application/octet-stream" },
    });
    const bytes = Buffer.from(response.data);
    if (bytes.length !== handle.size || materialDigest(bytes) !== handle.digest)
      throw new Error(
        "Retained transaction material failed integrity verification",
      );
    return bytes;
  }
  async function put(bytes) {
    if (bytes.length > 256 * 1024 * 1024)
      throw new Error("Transaction material exceeds the supported file bound");
    const digest = materialDigest(bytes),
      name = digest.replace(":", "-");
    const release = await archive();
    const find = async () => {
      const assets = await octokit.paginate(repos.listReleaseAssets, {
        owner,
        repo,
        release_id: release.id,
        per_page: 100,
      });
      const matches = assets.filter((asset) => asset.name === name);
      if (matches.length > 1)
        throw new Error("Ambiguous immutable transaction material");
      return matches[0];
    };
    let asset = await find();
    if (!asset) {
      try {
        asset = (
          await repos.uploadReleaseAsset({
            owner,
            repo,
            release_id: release.id,
            name,
            data: bytes,
            headers: {
              "content-type": "application/octet-stream",
              "content-length": bytes.length,
            },
          })
        ).data;
      } catch (error) {
        asset = await find();
        if (!asset)
          throw new Error("Transaction material upload outcome is unknown", {
            cause: error,
          });
      }
    }
    const handle = { id: asset.id, digest, size: bytes.length };
    await read(handle);
    return handle;
  }
  return { put, read };
}
