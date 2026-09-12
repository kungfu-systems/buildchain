import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discussionMaterials,
  materialDigest,
} from "../packages/core/providers/github/discussions/materials.js";
import {
  restoreRecoveryMaterials,
  retainRecoveryMaterials,
} from "../packages/core/release/discussion/checkpoints.js";

function materialProvider() {
  let release;
  const assets = [];
  let loseUpload = false;
  const calls = [];
  const repos = {
    async getReleaseByTag() {
      if (!release) throw Object.assign(new Error("missing"), { status: 404 });
      return { data: release };
    },
    async createRelease(input) {
      calls.push("create");
      release = { id: 1, draft: input.draft, tag_name: input.tag_name };
      return { data: release };
    },
    async listReleaseAssets() {
      return { data: assets };
    },
    async uploadReleaseAsset(input) {
      calls.push("upload");
      const asset = {
        id: assets.length + 1,
        name: input.name,
        bytes: input.data,
      };
      assets.push(asset);
      if (loseUpload) throw new Error("lost response");
      return { data: asset };
    },
    async getReleaseAsset({ asset_id }) {
      return { data: assets.find((asset) => asset.id === asset_id).bytes };
    },
  };
  const octokit = {
    rest: { repos },
    paginate: async (fn, args) => (await fn(args)).data,
  };
  return {
    octokit,
    assets,
    calls,
    loseResponse() {
      loseUpload = true;
    },
  };
}

test("material upload is content-addressed, read-back verified and response-loss safe", async () => {
  const fake = materialProvider();
  fake.loseResponse();
  const store = discussionMaterials({
    octokit: fake.octokit,
    repository: "example/consumer",
    intentId: `sha256:${"a".repeat(64)}`,
    sourceSha: "b".repeat(40),
  });
  const bytes = Buffer.from("immutable sealed bytes");
  const handle = await store.put(bytes);
  assert.deepEqual(await store.put(bytes), handle);
  assert.deepEqual(fake.calls, ["create", "upload"]);
  assert.deepEqual(await store.read(handle), bytes);
  fake.assets[0].bytes = Buffer.from("modified");
  await assert.rejects(store.read(handle), /integrity verification/);
});

test("recovery rejects escaping paths and symlink destinations before writing", async (t) => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-discussion-recovery-"),
  );
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const materials = { read: async () => Buffer.from("sealed") };
  const manifest = {
    schema: "buildchain.release-recovery-material/v1",
    files: [{ path: ".buildchain/../../escape" }],
    inputs: {},
  };
  await assert.rejects(
    restoreRecoveryMaterials(manifest, base, materials),
    /Unsafe/,
  );
  fs.mkdirSync(path.join(base, "elsewhere"));
  fs.symlinkSync(
    path.join(base, "elsewhere"),
    path.join(base, ".buildchain"),
    "dir",
  );
  manifest.files[0].path = ".buildchain/sealed.json";
  await assert.rejects(
    restoreRecoveryMaterials(manifest, base, materials),
    /symbolic link/,
  );
  assert.equal(
    fs.existsSync(path.join(base, "elsewhere", "sealed.json")),
    false,
  );
});

test("retention excludes runtime code and outside-workspace source paths", async (t) => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-discussion-retention-"),
  );
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const request = {
    "candidate-passport-path": path.join(workspace, "outside.json"),
  };
  fs.writeFileSync(request["candidate-passport-path"], "{}");
  let writes = 0;
  const materials = {
    put: async (bytes) => {
      writes++;
      return { digest: materialDigest(bytes) };
    },
  };
  await assert.rejects(
    retainRecoveryMaterials(
      { request, workspace, readerFile: "unused" },
      materials,
    ),
    /declared consumer evidence/,
  );
  assert.equal(writes, 0);
});

test("restoration preflights the complete inventory and retries identical retained bytes", async (t) => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-material-inventory-"),
  );
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const bytes = Buffer.from("sealed"),
    file = ".buildchain/release-candidate/sealed.json";
  const handle = {
    path: file,
    digest: materialDigest(bytes),
    size: bytes.length,
  };
  const manifest = {
    schema: "buildchain.release-recovery-material/v1",
    files: [handle, { ...handle, path: ".buildchain/../escape" }],
    inputs: { "candidate-passport-path": file },
    releaseAssets: [file],
  };
  let reads = 0;
  const materials = {
    read: async () => {
      reads++;
      return bytes;
    },
  };
  await assert.rejects(
    restoreRecoveryMaterials(manifest, base, materials),
    /Unsafe/,
  );
  assert.equal(reads, 0);
  manifest.files.pop();
  const first = await restoreRecoveryMaterials(manifest, base, materials);
  assert.deepEqual(
    await restoreRecoveryMaterials(manifest, base, materials),
    first,
  );
  manifest.releaseAssets = [".buildchain/not-retained.json"];
  await assert.rejects(
    restoreRecoveryMaterials(manifest, base, materials),
    /outside the retained inventory/,
  );
});
