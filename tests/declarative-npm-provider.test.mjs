import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { materializeCommandShim } from "./helpers/command-shim.mjs";
import { runPublishCommand } from "../packages/core/release/promote-ref/internal/publish-command.js";
import { normalizePromotionOptions } from "../packages/core/release/promote-ref/internal/promotion-options.js";
import { npmPublishTransaction } from "../packages/core/publication/npm/transaction.js";

test("declarative npm provider rejects mixed execution and unsealed rematerialization", () => {
  const publishProvider = {
    kind: "npm",
    directory: ".buildchain/admitted/package",
  };
  assert.equal(
    normalizePromotionOptions({ publishProvider }).publishTransaction,
    true,
  );
  for (const change of [
    { publishCommand: "unexpected" },
    { publishRematerializeOnResume: true },
    { publishProvider: { ...publishProvider, command: "unexpected" } },
    { publishProvider: { ...publishProvider, kind: "shell" } },
  ]) {
    assert.throws(() =>
      normalizePromotionOptions({ publishProvider, ...change }),
    );
  }
  assert.throws(
    () =>
      runPublishCommand({ provider: publishProvider, command: "unexpected" }),
    /ambiguous/,
  );
});
test("typed npm transaction verifies exact sealed bytes without invoking a publish command", (t) => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-npm-provider-"),
  );
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const bytes = Buffer.from("sealed package fixture"),
    tarball = path.join(workspace, "package.tgz"),
    evidence = path.join(workspace, "evidence.json");
  fs.writeFileSync(tarball, bytes);
  fs.writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify({
      name: "@acme/paper",
      version: "1.0.0-alpha.0",
      private: false,
    }),
  );
  const publication = {
    version: "1.0.0-alpha.0",
    distTag: "alpha",
    tarballPath: tarball,
    integrity: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    evidencePath: evidence,
    sourceSha: "a".repeat(40),
    releaseSha: "a".repeat(40),
    channel: "alpha",
    targetRef: "alpha/v1/v1.0",
  };
  assert.throws(
    () =>
      npmPublishTransaction({
        cwd: workspace,
        publication: {
          ...publication,
          evidencePath: "",
          tarballPath: "absent.tgz",
        },
        env: { PATH: "" },
      }),
    /evidencePath is required before npm effects/,
  );
  const result = npmPublishTransaction({
    cwd: workspace,
    publication,
    env: { PATH: "" },
    dryRunPublish: true,
    skipRegistryLookup: true,
  });
  assert.equal(result.pack.sealed, true);
  assert.equal(result.publishAction, "dry-run");
  assert.equal(
    JSON.parse(fs.readFileSync(evidence)).artifacts[0].digest,
    publication.integrity,
  );
  fs.writeFileSync(tarball, "substituted");
  assert.throws(
    () =>
      npmPublishTransaction({
        cwd: workspace,
        publication,
        env: { PATH: "" },
        dryRunPublish: true,
        skipRegistryLookup: true,
      }),
    /integrity mismatch/,
  );
});

test("shared ref publication dispatches its npm provider through the typed transaction", (t) => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-ref-npm-provider-"),
  );
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const packageDirectory = path.join(workspace, "sealed"),
    bin = path.join(workspace, "bin");
  fs.mkdirSync(packageDirectory);
  fs.mkdirSync(bin);
  const tarball = path.join(packageDirectory, "paper.tgz"),
    bytes = Buffer.from("exact already-published bytes"),
    integrity = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
  fs.writeFileSync(tarball, bytes);
  fs.writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({ name: "@acme/paper", version: "1.0.0-alpha.0" }),
  );
  materializeCommandShim(
    path.join(bin, "npm"),
    `#!/usr/bin/env node
if (process.argv[2] !== "view") throw new Error("Unexpected mutation or pack");
process.stdout.write(JSON.stringify({ integrity: ${JSON.stringify(integrity)} }));
`,
  );
  const evidence = path.join(workspace, "evidence.json");
  const source = runPublishCommand({
    cwd: workspace,
    provider: { kind: "npm", directory: "sealed" },
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      BUILDCHAIN_VERSION: "1.0.0-alpha.0",
      BUILDCHAIN_CHANNEL: "alpha",
      BUILDCHAIN_SOURCE_SHA: "a".repeat(40),
      BUILDCHAIN_RELEASE_SHA: "a".repeat(40),
      BUILDCHAIN_TARGET_REF: "alpha/v1/v1.0",
      BUILDCHAIN_SEALED_NPM_TARBALL: tarball,
      BUILDCHAIN_SEALED_NPM_INTEGRITY: integrity,
      BUILDCHAIN_PUBLISH_EVIDENCE: evidence,
    },
  });
  assert.equal(source, "provider:npm");
  assert.equal(
    JSON.parse(fs.readFileSync(evidence)).artifacts[0].digest,
    integrity,
  );
});
