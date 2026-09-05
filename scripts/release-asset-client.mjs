import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  reconcileImmutableReleaseAssets,
  uniqueReleaseAssets,
} from "../actions/promote-buildchain-ref/reuse-complete-release.js";

export function releaseAssetClient(
  repository,
  { execute = execFileSync } = {},
) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository))
    throw new Error("exact repository required");
  const [owner, repo] = repository.split("/");
  const raw = (endpoint, args = []) =>
    execute("gh", ["api", endpoint, ...args], {
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const json = (endpoint) => JSON.parse(raw(endpoint));
  const assetBytes = (asset) =>
    raw(`repos/${repository}/releases/assets/${asset.id}`, [
      "-H",
      "Accept: application/octet-stream",
    ]);
  return {
    json,
    assetBytes,
    release: (tag) =>
      json(`repos/${repository}/releases/tags/${encodeURIComponent(tag)}`),
    async publish(release, files) {
      const octokit = {
        rest: {
          repos: {
            getReleaseAsset: async ({ asset_id }) => ({
              data: assetBytes({ id: asset_id }),
            }),
          },
        },
      };
      const result = await reconcileImmutableReleaseAssets({
        octokit,
        owner,
        repo,
        releaseId: release.id,
        remoteAssets: uniqueReleaseAssets(release.assets || []),
        assetPaths: files,
        uploadReleaseAsset: async ({ name }) => {
          const file = files.find((file) => path.basename(file) === name);
          return JSON.parse(
            raw(
              `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
              [
                "--method",
                "POST",
                "--input",
                file,
                "-H",
                "Content-Type: application/octet-stream",
              ],
            ),
          );
        },
      });
      // A successful upload response alone is not the provider readback.
      const observed = this.release(release.tag_name);
      await reconcileImmutableReleaseAssets({
        octokit,
        owner,
        repo,
        releaseId: release.id,
        remoteAssets: uniqueReleaseAssets(observed.assets || []),
        assetPaths: files,
        uploadReleaseAsset: async () => {
          throw new Error("uploaded release asset missing on readback");
        },
      });
      return result.map(({ action, name, digest }) => ({
        action,
        name,
        digest,
      }));
    },
    write(file, value) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    },
  };
}
