import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createActivationReceiptProjectorAdapter,
  createGitHubReleaseAssetsAdapter,
  createSignedStaticChannelAdapter,
  githubReleaseAssetsTargetRoot,
} from "../packages/core/release-tail-provider-adapters.js";
import {
  compileReleaseTailDeclaration,
  releaseTailRoot,
} from "../packages/core/release-tail-provider-plane.js";

function declaration() {
  return JSON.parse(
    fs.readFileSync(
      "contracts/fixtures/release-tail-capabilities-v1/kungfu-alpha.json",
      "utf8",
    ),
  );
}

function effect(capabilityId) {
  return compileReleaseTailDeclaration(declaration()).effects.find(
    (entry) => entry.capabilityId === capabilityId,
  );
}

test("rooted document adapters mutate only the sealed target and read it back", async () => {
  let remote = null;
  const document = { schema: "kungfu.test.channel/v1", channel: "alpha" };
  const sealed = {
    ...effect("signed-channel.commit"),
    targetRoot: releaseTailRoot(document),
  };
  const adapter = createSignedStaticChannelAdapter({
    readDocument: () => remote,
    resolveDocument: () => document,
    commitDocument: ({ document: value }) => {
      remote = value;
    },
  });
  assert.equal((await adapter.readback(sealed)).outcome, "absent");
  await adapter.apply(sealed);
  const observed = await adapter.readback(sealed);
  assert.equal(observed.outcome, "observed");
  assert.equal(observed.targetRoot, sealed.targetRoot);

  await assert.rejects(
    () => adapter.apply({ ...sealed, targetRoot: `sha256:${"f".repeat(64)}` }),
    /sealed target root/u,
  );
});

test("released-evidence projector is deterministic and enforces its output root", async () => {
  let stored = null;
  const document = {
    schema: "kungfu.buildchain.released-evidence/v1",
    receipts: ["sha256:" + "1".repeat(64)],
  };
  const sealed = {
    ...effect("released-evidence.synthesize"),
    targetRoot: releaseTailRoot(document),
  };
  const adapter = createActivationReceiptProjectorAdapter({
    readEvidence: () => stored,
    synthesizeEvidence: () => structuredClone(document),
    writeEvidence: ({ document: value }) => {
      stored = value;
    },
  });
  await adapter.apply(sealed);
  assert.equal((await adapter.readback(sealed)).targetRoot, sealed.targetRoot);
});

test("GitHub Release adapter uploads sealed assets and rejects immutable collisions", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-tail-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const artifactPath = path.join(temporary, "artifact.tar.gz");
  fs.writeFileSync(artifactPath, "sealed artifact\n");
  const artifactRoot = `sha256:${crypto
    .createHash("sha256")
    .update(fs.readFileSync(artifactPath))
    .digest("hex")}`;
  let release = null;
  const assets = [];
  const octokit = {
    rest: {
      repos: {
        async getReleaseByTag() {
          if (!release)
            throw Object.assign(new Error("missing"), { status: 404 });
          return { data: release };
        },
        async listReleaseAssets() {
          return { data: assets };
        },
        async createRelease() {
          release = { id: 7 };
          return { data: release };
        },
        async uploadReleaseAsset({ name, data }) {
          assets.push({
            name,
            digest: `sha256:${crypto.createHash("sha256").update(data).digest("hex")}`,
          });
          return { data: assets.at(-1) };
        },
      },
    },
  };
  const base = effect("artifact.publish");
  const artifactRoles = [{ role: "release-bundle", root: artifactRoot }];
  const sealed = {
    ...base,
    artifactRoles,
    targetRoot: githubReleaseAssetsTargetRoot({
      destination: base.destination,
      artifacts: [
        { role: "release-bundle", root: artifactRoot, name: "artifact.tar.gz" },
      ],
    }),
  };
  const adapter = createGitHubReleaseAssetsAdapter({
    octokit,
    resolveArtifact: () => ({ path: artifactPath, name: "artifact.tar.gz" }),
  });
  await adapter.apply(sealed);
  assert.equal((await adapter.readback(sealed)).targetRoot, sealed.targetRoot);

  assets[0].digest = `sha256:${"e".repeat(64)}`;
  await assert.rejects(
    () => adapter.apply(sealed),
    /immutable GitHub Release asset collision/u,
  );
});
