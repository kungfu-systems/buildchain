import assert from "node:assert/strict";
import test from "node:test";
import {
  createComposePreviewRegistry,
  promoteComposePreview,
} from "../scripts/oci-compose-preview.mjs";

test("preview registry uses explicit package identity and never falls back to governance identity", async () => {
  const environment = {
    GH_TOKEN: "governance-fixture",
    BUILDCHAIN_REGISTRY_TOKEN: "packages-fixture",
    GITHUB_ACTOR: "publisher-fixture",
  };
  const requests = [];
  const { registry } = createComposePreviewRegistry(
    environment,
    async (url, options) => {
      requests.push({ url: String(url), options });
      return url.pathname === "/token"
        ? { ok: true, json: async () => ({ token: "registry-bearer-fixture" }) }
        : { status: 201 };
    },
  );
  await registry(
    { repository: "ghcr.io/example/runtime/hub" },
    "manifests/compose-preview",
    { write: true, method: "PUT", body: Buffer.from("sealed") },
  );
  assert.equal(requests.length, 2);
  assert.equal(
    new URL(requests[0].url).searchParams.get("scope"),
    "repository:example/runtime/hub:pull,push",
  );
  assert.equal(
    requests[0].options.headers.authorization,
    `Basic ${Buffer.from("publisher-fixture:packages-fixture").toString("base64")}`,
  );
  assert.equal(
    requests[1].options.headers.authorization,
    "Bearer registry-bearer-fixture",
  );
  assert.equal(JSON.stringify(requests).includes("governance-fixture"), false);
  for (const missing of ["BUILDCHAIN_REGISTRY_TOKEN", "GITHUB_ACTOR"]) {
    const incomplete = { ...environment };
    delete incomplete[missing];
    assert.throws(
      () => createComposePreviewRegistry(incomplete),
      /explicit scoped registry identity required/u,
    );
  }
});

test("rejected preview writes expose safe status and cannot produce a success receipt", async () => {
  const digest = "sha256:" + "a".repeat(64),
    previousDigest = "sha256:" + "b".repeat(64);
  const context = {
    tag: "v1.0.0-alpha.15",
    application: {
      kind: "compose",
      tag: "compose-v{version}",
      repository: "ghcr.io/example/runtime/hub",
      digest,
    },
    policy: { alias: "compose-preview", previousDigest },
  };
  let reads = 0;
  await assert.rejects(
    promoteComposePreview({
      context,
      receipt: {},
      fetchManifest: async (ref) => {
        reads++;
        return {
          digest: ref === "compose-preview" ? previousDigest : digest,
          bytes: Buffer.from("sealed"),
          mediaType: "application/vnd.oci.image.manifest.v1+json",
        };
      },
      registry: async () => ({ status: 403 }),
    }),
    /preview write uncertain \(HTTP 403\)/u,
  );
  assert.equal(reads, 2);
});
