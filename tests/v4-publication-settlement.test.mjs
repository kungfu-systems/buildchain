import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  verifyPublicationSettlement,
  SETTLEMENT_ASSET,
} from "../scripts/v4-publication-settlement.mjs";
import {
  readBinaryPublicationEvidence,
  prepareBinaryAssetPaths,
} from "../scripts/binary-publication-evidence.mjs";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL(
      "./fixtures/v4-alpha34-publication-settlement.json",
      import.meta.url,
    ),
  ),
);
const documents = fixture.documents;
const expected = {
  repository: "kungfu-systems/buildchain",
  tag: "v4.0.2-alpha.34",
  sourceSha: "dd87f43f7122b41c4ce7f1f6d1888521cc7f892f",
  publicPassport: documents.passport,
};

test("a failed APPLY run retains the actual completed alpha publication receipt", () => {
  assert.equal(fixture.source.applyOutcome, "failure");
  assert.deepEqual(verifyPublicationSettlement(documents, expected), {
    publication: "complete",
    receiptRoot: documents.receipt.receiptRoot,
    repository: expected.repository,
    tag: expected.tag,
    sourceSha: expected.sourceSha,
  });
});

test("publication verification rejects tampering in every retained authority document", () => {
  for (const [key, field] of [
    ["receipt", "outcome"],
    ["transaction", "transactionRoot"],
    ["invocation", "schema"],
    ["passport", "passportRoot"],
    ["product", "root"],
    ["providerState", "stateRoot"],
    ["productState", "stateRoot"],
  ]) {
    const changed = structuredClone(documents);
    changed[key][field] = "tampered";
    assert.throws(
      () => verifyPublicationSettlement(changed, expected),
      undefined,
      key,
    );
  }
  for (const changed of [
    { sourceSha: "a".repeat(40) },
    { candidateSha: "a".repeat(40) },
    { repository: "other/repo" },
    { tag: "v4.0.2-alpha.33" },
    { publicPassport: { ...documents.passport, changed: true } },
  ])
    assert.throws(() =>
      verifyPublicationSettlement(documents, { ...expected, ...changed }),
    );
});

test("binary publication waits for exact persistent evidence and does not require a green parent run", async () => {
  let reads = 0;
  let waits = 0;
  const settlement = {
    contract: "buildchain-v4-publication-settlement/v1",
    release: { sourceSha: expected.sourceSha, tag: expected.tag },
    documents,
  };
  const client = {
    release: () => ({
      assets:
        ++reads < 2
          ? []
          : [{ name: SETTLEMENT_ASSET }, { name: "buildchain.release.json" }],
    }),
    json: () => ({ sha: expected.sourceSha }),
    assetBytes: ({ name }) =>
      JSON.stringify(
        name === SETTLEMENT_ASSET ? settlement : documents.passport,
      ),
  };
  const input = {
    ...expected,
    client,
    attempts: 2,
    wait: async () => {
      waits++;
    },
  };
  assert.deepEqual(await readBinaryPublicationEvidence(input), settlement);
  assert.equal(waits, 1);
  await assert.rejects(
    readBinaryPublicationEvidence({
      ...input,
      client: { ...client, release: () => ({ assets: [] }) },
    }),
    /bounded wait/u,
  );
  await assert.rejects(
    readBinaryPublicationEvidence({
      ...input,
      client: { ...client, json: () => ({ sha: "a".repeat(40) }) },
    }),
    /exact release tag/u,
  );
});

test("binary asset preparation preserves publication Passport and assigns a separate binary Passport", (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-binary-assets-"),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  for (const dir of ["binary", "passport"])
    fs.mkdirSync(path.join(temporary, dir));
  const passport = path.join(temporary, "passport", "buildchain.release.json");
  fs.writeFileSync(passport, "binary-passport");
  fs.writeFileSync(
    path.join(temporary, "binary", "checksums.txt"),
    "checksums",
  );
  const capability = path.join(temporary, "capability.json");
  fs.writeFileSync(capability, "sealed capability");
  const files = prepareBinaryAssetPaths({
    binaryDir: path.join(temporary, "binary"),
    passportDir: path.join(temporary, "passport"),
    outputDir: path.join(temporary, "out"),
    capabilityPath: capability,
  });
  assert.ok(
    files.some(
      (file) => path.basename(file) === "buildchain.binary.release.json",
    ),
  );
  assert.ok(
    files.every((file) => path.basename(file) !== "buildchain.release.json"),
  );
  assert.equal(fs.readFileSync(passport, "utf8"), "binary-passport");
  const authorization = files.find((file) =>
    /buildchain\.binary\.capability-[a-f0-9]{64}\.json$/u.test(file),
  );
  assert.equal(fs.readFileSync(authorization, "utf8"), "sealed capability");
});

test("failed next-development cannot hide receipt validation or grant SETTLE write authority", () => {
  const workflow = fs.readFileSync(
    new URL(
      "../.github/workflows/.release-candidate-promote.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const settle = workflow.slice(workflow.indexOf("\n  settle:"));
  assert.doesNotMatch(
    settle,
    /needs\.apply\.result == 'success'|contents: write/u,
  );
  assert.match(settle, /verifyPublicationSettlement/u);
  const binary = fs.readFileSync(
    new URL("../.github/workflows/.binary-release-assets.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    binary.slice(
      0,
      binary.indexOf("      - name: Upload GitHub Release assets"),
    ),
    /--clobber/u,
  );
  assert.match(binary, /binary-publication-evidence\.mjs publish/u);
});

test("immutable upload checks every collision before writing and rejects absent provider readback", async (t) => {
  const crypto = await import("node:crypto");
  const { releaseAssetClient } =
    await import("../scripts/release-asset-client.mjs");
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-assets-client-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = ["archive.tgz", "passport.json"].map((name) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, name);
    return file;
  });
  const digest = (value) =>
    `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
  const release = { id: 1, tag_name: "v4.0.2-alpha.35", assets: [] };
  let uploads = 0;
  const client = releaseAssetClient("owner/repo", {
    execute: (_command, args) => {
      if (args.includes("POST")) {
        uploads++;
        const file = args[args.indexOf("--input") + 1];
        const asset = {
          id: uploads,
          name: path.basename(file),
          digest: digest(fs.readFileSync(file)),
        };
        release.assets.push(asset);
        return Buffer.from(JSON.stringify(asset));
      }
      return Buffer.from(JSON.stringify(release));
    },
  });
  const bad = {
    ...release,
    assets: [{ id: 3, name: "passport.json", digest: digest("conflict") }],
  };
  await assert.rejects(client.publish(bad, files), /immutable.*collision/u);
  assert.equal(uploads, 0);
  assert.deepEqual(
    (await client.publish(release, files)).map((a) => a.action),
    ["uploaded", "uploaded"],
  );
  assert.deepEqual(
    (await client.publish(release, files)).map((a) => a.action),
    ["preserved", "preserved"],
  );
  assert.equal(uploads, 2);
  const missing = releaseAssetClient("owner/repo", {
    execute: () => Buffer.from(JSON.stringify({ ...release, assets: [] })),
  });
  await assert.rejects(
    missing.publish({ ...release, assets: [] }, files),
    /missing on readback/u,
  );
});
