import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publicationSettlementFixture } from "./helpers/publication-settlement.mjs";
import * as binaryEvidence from "../packages/core/publication/commands/binary-publication-evidence.mjs";
import { collectGitHubReleasePassport } from "../packages/core/release/passport/collection.js";
import {
  verifyPublicationSettlement,
  SETTLEMENT_ASSET,
} from "../packages/core/publication/commands/publication-settlement.mjs";
import {
  readBinaryPublicationEvidence,
  prepareBinaryAssetPaths,
} from "../packages/core/publication/commands/binary-publication-evidence.mjs";

const fixture = await publicationSettlementFixture();
const documents = fixture.documents;
const expected = {
  repository: documents.invocation.candidate.repository,
  tag: fixture.release.tag,
  sourceSha: fixture.release.sourceSha,
  publicPassport: documents.passport,
};

test("a completed publication receipt remains valid independently of APPLY outcome", () => {
  assert.deepEqual(verifyPublicationSettlement(documents, expected), {
    publication: "complete",
    receiptRoot: documents.receipt.receiptRoot,
    repository: expected.repository,
    tag: expected.tag,
    sourceSha: expected.sourceSha,
  });
});

test("historical provider snapshots remain unmodified and do not authorize the current publisher", () => {
  for (const name of ["alpha34", "stable404"]) {
    const snapshot = JSON.parse(
      fs.readFileSync(
        new URL(
          `./fixtures/${name}-publication-settlement.json`,
          import.meta.url,
        ),
      ),
    );
    assert.equal(
      snapshot.documents.invocation.publisher.workflow,
      ".github/workflows/.release-candidate-promote.yml",
    );
    assert.throws(
      () => verifyPublicationSettlement(snapshot.documents, {}),
      /publisher|workflow/,
    );
  }
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
    new URL("../.github/workflows/.release-promote.yml", import.meta.url),
    "utf8",
  );
  const settle = workflow.slice(workflow.indexOf("\n  settle:"));
  assert.doesNotMatch(
    settle,
    /needs\.apply\.result == 'success'|contents: write/u,
  );
  assert.match(settle, /actions\/release\/promote-settle/u);
  const adapter = fs.readFileSync(
    new URL(
      "../packages/core/release/nodes/promotion-settlement.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(adapter, /verifyPublicationSettlement/u);
  const binary = fs.readFileSync(
    new URL(
      "../actions/release/binary-assets-publish/action.yml",
      import.meta.url,
    ),
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
    await import("../packages/core/providers/commands/release-asset-client.mjs");
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

test("binary settlement tolerates protected finalization beyond ten minutes but remains bounded", async () => {
  const settlement = {
    contract: "buildchain-v4-publication-settlement/v1",
    release: { sourceSha: expected.sourceSha, tag: expected.tag },
    documents,
  };
  let reads = 0;
  const client = {
    release: () => ({
      assets:
        ++reads > 48
          ? [{ name: SETTLEMENT_ASSET }, { name: "buildchain.release.json" }]
          : [],
    }),
    json: () => ({ sha: expected.sourceSha }),
    assetBytes: ({ name }) =>
      JSON.stringify(
        name === SETTLEMENT_ASSET ? settlement : documents.passport,
      ),
  };
  assert.deepEqual(
    await readBinaryPublicationEvidence({
      ...expected,
      client,
      wait: async () => {},
    }),
    settlement,
  );
  reads = 0;
  await assert.rejects(
    readBinaryPublicationEvidence({
      ...expected,
      client: {
        ...client,
        release: () => {
          reads++;
          return { assets: [] };
        },
      },
      wait: async () => {},
    }),
    /bounded wait/,
  );
  assert.equal(reads, 160);
});

test("stable binary Passport uses verified publication version despite alpha source package", async (t) => {
  const settlement = await publicationSettlementFixture({ channel: "stable" });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "binary-stable-passport-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({
      name: "@kungfu-tech/buildchain",
      version: "4.1.0-alpha.0",
    }),
  );
  fs.mkdirSync(path.join(cwd, "assets"));
  fs.writeFileSync(
    path.join(cwd, "assets", "buildchain.tar.gz"),
    "binary fixture",
  );
  const writes = new Map();
  const client = {
    release: () => ({
      assets: [{ name: SETTLEMENT_ASSET }, { name: "buildchain.release.json" }],
    }),
    json: () => ({ sha: settlement.release.sourceSha }),
    assetBytes: ({ name }) =>
      JSON.stringify(
        name === SETTLEMENT_ASSET ? settlement : settlement.documents.passport,
      ),
    write: (name, value) => writes.set(name, value),
  };
  await binaryEvidence.writeBinaryPublicationEvidence({
    client,
    repository: "kungfu-systems/buildchain",
    tag: settlement.release.tag,
    sourceSha: settlement.release.sourceSha,
  });
  const release = writes.get(".buildchain/publication-evidence/release.json");
  const collected = collectGitHubReleasePassport({
    cwd,
    tag: settlement.release.tag,
    sourceSha: settlement.release.sourceSha,
    assetsDir: "assets",
    outputDir: "passport",
    packageVersion: release.publishedVersion,
    releaseJsonExtra: JSON.stringify(release),
  });
  const passport = JSON.parse(
    fs.readFileSync(path.join(collected.outputDir, "buildchain.release.json")),
  );
  for (const actual of [
    passport.release.publishedVersion,
    passport.release.versionLabel,
    passport.release.package.version,
  ])
    assert.equal(actual, "4.1.0");
  assert.equal(passport.release.channel, "stable");
  assert.deepEqual(
    writes.get(`.buildchain/publication-evidence/${SETTLEMENT_ASSET}`),
    settlement,
  );
  const workflow = fs.readFileSync(
    new URL(
      "../.github/workflows/self-build-binary-distribution.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    workflow,
    /actions\/build\/binary-distribution-passport/,
  );
  const { binaryPassportOptions } = await import("../packages/core/build/nodes/binary-distribution.mjs");
  const options = binaryPassportOptions({ RELEASE_TAG: settlement.release.tag }, name => writes.get(name));
  assert.equal(options.packageVersion, "4.1.0");
  assert.match(
    workflow,
    /name: Collect release passport[\s\S]*?timeout-minutes: 45/,
  );
});
