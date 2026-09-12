import { createHash } from "node:crypto";

export function materialDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// Draft release assets retain immutable recovery bytes outside the source Git
// object database. Only the Discussion record selects a committed manifest.
export function discussionMaterials({
  octokit,
  repository,
  intentId,
  authorityDescription = "The associated Discussion owns transaction state.",
}) {
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
            body: `Immutable recovery material. ${authorityDescription}`,
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
  async function put(bytes, descriptor = {}) {
    const extension =
      descriptor.name?.match(/\.([a-zA-Z0-9]{1,8})$/u)?.[1] || "";
    if (bytes.length > 256 * 1024 * 1024)
      throw new Error("Transaction material exceeds the supported file bound");
    const digest = materialDigest(bytes),
      name = digest.replace(":", "-") + (extension ? `.${extension}` : "");
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
              "content-type":
                descriptor.mediaType || "application/octet-stream",
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
    const handle = {
      id: asset.id,
      digest,
      size: bytes.length,
      ...(asset.browser_download_url
        ? { downloadUrl: asset.browser_download_url }
        : {}),
      ...(release.html_url ? { archiveUrl: release.html_url } : {}),
    };
    await read(handle);
    return handle;
  }
  async function diagnose(operation, effect) {
    try {
      return await effect();
    } catch (error) {
      let cause = error;
      for (let depth = 0; depth < 4 && cause.cause; depth++)
        cause = cause.cause;
      const details = [
        operation,
        cause.name,
        cause.status,
        cause.request?.method,
        cause.response?.data?.errors?.[0]?.code,
        cause.code,
      ].filter(Boolean);
      error.code = `discussion-material-${details
        .join("-")
        .replace(/[^a-zA-Z0-9-]/gu, "-")
        .slice(0, 140)}`;
      throw error;
    }
  }
  return {
    put: (bytes, descriptor) => diagnose("put", () => put(bytes, descriptor)),
    read: (handle) => diagnose("read", () => read(handle)),
  };
}
