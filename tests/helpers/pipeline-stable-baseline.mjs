import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { publicationSettlementFixture } from "./publication-settlement.mjs";

export async function stableBaselineFixture() {
  const repository = "example/product",
    sourceSha = "c".repeat(40),
    promotedSha = "8".repeat(40),
    version = "1.0.0";
  const settlement = await publicationSettlementFixture({
    channel: "stable",
    repository,
    sourceSha,
    promotedSha,
    version,
  });
  const release = { id: 10, tag: `v${version}` },
    prior = { commit: sourceSha };
  const plan = {
    source: { repository },
    version: "1.1.0",
    previousChannelCommit: promotedSha,
  };
  const documents = {
    "buildchain-publication-settlement.json": settlement,
    "buildchain.release.json": settlement.documents.passport,
  };
  const downloads = new Map(),
    assets = [],
    calls = [];
  function encode() {
    assets.length = 0;
    for (const [name, value] of Object.entries(documents)) {
      const bytes = Buffer.from(JSON.stringify(value)),
        id = 100 + assets.length;
      downloads.set(id, bytes);
      assets.push({
        id,
        name,
        state: "uploaded",
        size: bytes.length,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      });
    }
  }
  encode();
  const host = {
    repository,
    async request(endpoint, options = {}) {
      assert.equal(options.method || "GET", "GET");
      assert.equal(
        endpoint,
        `/repos/${repository}/releases/10/assets?per_page=100&page=1`,
      );
      calls.push(endpoint);
      return structuredClone(assets);
    },
    github: {
      rest: {
        repos: {
          async getReleaseAsset(input) {
            assert.equal(input.owner, "example");
            assert.equal(input.repo, "product");
            assert.equal(input.headers.accept, "application/octet-stream");
            return { data: downloads.get(input.asset_id) };
          },
        },
      },
    },
  };
  return {
    plan,
    host,
    release,
    prior,
    settlement,
    documents,
    downloads,
    assets,
    calls,
    encode,
  };
}
