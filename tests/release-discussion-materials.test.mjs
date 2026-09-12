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
  releaseCheckpoints,
  restoreRecoveryMaterials,
  retainRecoveryMaterials,
} from "../packages/core/release/discussion/checkpoints.js";

function materialProvider() {
  let release;
  const assets = [];
  let loseUpload = false,
    loseCreate = false,
    duplicates = 0;
  const calls = [];
  const repos = {
    async getReleaseByTag() {
      throw new Error("Draft archives are not published tag releases");
    },
    async listReleases() {
      return {
        data: release ? [release, ...Array(duplicates).fill(release)] : [],
      };
    },
    async createRelease(input) {
      assert.equal(
        Object.hasOwn(input, "target_commitish"),
        false,
        "archive creation must not require workflow-write permission on a candidate commit",
      );
      calls.push("create");
      release = {
        id: 1,
        draft: input.draft,
        tag_name: input.tag_name,
        html_url:
          "https://github.com/example/consumer/releases/tag/untagged-materials",
      };
      if (loseCreate) throw new Error("lost create response");
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
        browser_download_url: `https://github.com/example/consumer/releases/download/untagged-materials/${input.name}`,
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
    duplicateArchive() {
      duplicates++;
    },
    loseCreateResponse() {
      loseCreate = true;
    },
    loseResponse() {
      loseUpload = true;
    },
  };
}

test("material upload is content-addressed, read-back verified and response-loss safe", async () => {
  const fake = materialProvider();
  fake.loseResponse();
  fake.loseCreateResponse();
  const store = discussionMaterials({
    octokit: fake.octokit,
    repository: "example/consumer",
    intentId: `sha256:${"a".repeat(64)}`,
  });
  const bytes = Buffer.from("immutable sealed bytes");
  const handle = await store.put(bytes);
  assert.deepEqual(await store.put(bytes), handle);
  assert.deepEqual(fake.calls, ["create", "upload"]);
  assert.deepEqual(await store.read(handle), bytes);
  fake.duplicateArchive();
  await assert.rejects(
    discussionMaterials({
      octokit: fake.octokit,
      repository: "example/consumer",
      intentId: `sha256:${"a".repeat(64)}`,
    }).put(Buffer.from("new material")),
    /Ambiguous transaction material archive/,
  );
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

test("runtime recovery preserves the first public reader while retaining each writer decoder", async () => {
  const { createIntent } =
    await import("../packages/core/release/discussion/envelope.js");
  const fake = materialProvider();
  const runtime = {
    repository: "example/buildchain",
    sha: "a".repeat(40),
    readerDigest: `sha256:${"b".repeat(64)}`,
  };
  const intent = createIntent({
    repository: "example/consumer",
    key: "1.0.0",
    source: { version: "1.0.0" },
    runtime,
    expectedNodes: ["qualification"],
  });
  const records = [],
    attempts = ["100:1", "200:1"];
  const session = { intent, runtime, attempt: attempts[0], predecessor: "" };
  const store = {
    read: async () => ({ records, attempts }),
    append: async (_session, record) => records.push(record),
  };
  const retained = releaseCheckpoints({
    session,
    store,
    octokit: fake.octokit,
  });
  const original = Buffer.from("original decoder"),
    repaired = Buffer.from("repaired decoder");
  assert.deepEqual(await retained.publicationReader(original), original);
  await retained.checkpoint("qualification", {
    schema: "buildchain.release-recovery-material/v1",
    reader: await retained.materials.put(original),
  });
  session.attempt = attempts[1];
  session.predecessor = attempts[0];
  await retained.checkpoint("qualification", {
    schema: "buildchain.release-recovery-material/v1",
    reader: await retained.materials.put(repaired),
  });
  records.reverse();
  assert.deepEqual(await retained.publicationReader(repaired), original);
  assert.equal(records.length, 2);
});

test("material failure exposes bounded provider classification without credential details", async () => {
  const fake = materialProvider();
  fake.octokit.rest.repos.uploadReleaseAsset = async () => {
    throw Object.assign(new Error("secret request details must not escape"), {
      name: "HttpError",
      status: 422,
      request: { method: "POST", headers: { authorization: "secret" } },
      response: { data: { errors: [{ code: "invalid" }] } },
    });
  };
  const store = discussionMaterials({
    octokit: fake.octokit,
    repository: "example/consumer",
    intentId: `sha256:${"a".repeat(64)}`,
  });
  await assert.rejects(
    store.put(Buffer.from("material")),
    (error) =>
      error.code === "discussion-material-put-HttpError-422-POST-invalid",
  );
});

test("Octokit transfers raw material bytes with automatically calculated HTTP length", async () => {
  const { getOctokit } = await import("@actions/github");
  const { createServer } = await import("node:http");
  const bytes = Buffer.alloc(40960, 123);
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.equal(Number(request.headers["content-length"]), bytes.length);
    response.writeHead(201, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = getOctokit("test-credential", {
      request: {
        fetch: (_url, options) =>
          fetch(`http://127.0.0.1:${server.address().port}/assets`, options),
      },
    });
    await client.rest.repos.uploadReleaseAsset({
      owner: "example",
      repo: "consumer",
      release_id: 1,
      name: "material",
      data: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("diagnostics attach a byte-verified JSON report and text log to the owning checkpoint", async () => {
  const fake = materialProvider();
  const runtime = {
    repository: "example/buildchain",
    sha: "a".repeat(40),
    readerDigest: `sha256:${"b".repeat(64)}`,
  };
  const { createIntent } =
    await import("../packages/core/release/discussion/envelope.js");
  const intent = createIntent({
    repository: "example/consumer",
    key: "1.0.0",
    expectedNodes: ["publication"],
    source: {},
    runtime,
  });
  const records = [];
  const session = { intent, runtime, attempt: "100:1", predecessor: "" };
  const store = {
    read: async () => ({ records }),
    append: async (_session, record) => records.push(record),
  };
  const retained = releaseCheckpoints({
    session,
    store,
    octokit: fake.octokit,
  });
  const result = await retained.diagnostics("publication", "publish-failed");
  assert.equal(records.length, 1);
  assert.equal(result.kind, "checkpoint");
  assert.equal(result.attempt, session.attempt);
  assert.deepEqual(
    result.payload.attachments.map((a) => a.mediaType),
    ["application/json", "text/plain"],
  );
  for (const attachment of result.payload.attachments) {
    assert.match(
      attachment.downloadUrl,
      /^https:\/\/github.com\/example\/consumer\/releases\/download\//,
    );
    assert.equal(
      materialDigest(await retained.materials.read(attachment)),
      attachment.digest,
    );
  }
  assert.equal((await retained.readCheckpoint(result)).code, "publish-failed");
});
