import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createManualUpstreamPickupCapture,
  createManualUpstreamPickupPlan,
  resolveNpmRegistryRelease,
} from "@kungfu-tech/buildchain/release-propagation";
import { normalizeUpstreamRelease } from "../packages/core/release-propagation-release.js";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "bin", "buildchain.mjs");
const sourceSha = "1e7ced9245a0ad9811327a90f6420fc745852c98";
const subjectSha512 =
  "a580c819025bffff0ff43a5a641474a9890b6daad2feb7c4ce53d58984bfbf67280c50aaa94f150e3e76d58f7a36405689f56aa3ae9572cbb9118b68a852934c";
const integrity = `sha512-${Buffer.from(subjectSha512, "hex").toString("base64")}`;

function executionProfile() {
  return {
    contract: "kungfu-buildchain-github-web-surface-execution",
    workflow: "buildchain-web-surface.yml",
    productionReleaseLabel: "buildchain-release",
    productionReleaseHeadPrefix: "release/",
    productionStatusUrl:
      "https://libkungfu.dev/.well-known/kungfu-release-status.json",
    readbackUrls: ["https://libkungfu.dev/buildchain/"],
    updateCommand: "pnpm run upstream:pickup:apply",
    prepareCommand: "pnpm install --lockfile-only --ignore-scripts",
    verifyCommand: "pnpm run check",
  };
}

function config() {
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-manual-upstream-pickup",
    runtime: { package: "@kungfu-tech/buildchain", version: "3.0.5-alpha.7" },
    downstream: {
      id: "site-libkungfu-dev",
      repository: "kungfu-systems/site-libkungfu-dev",
      baseRef: "main",
      executionProfile: executionProfile(),
    },
    sources: [
      {
        id: "buildchain",
        repository: "kungfu-systems/buildchain",
        package: "@kungfu-tech/buildchain",
        lockPath: "buildchain.upstreams/buildchain.release.json",
        distTags: { alpha: "alpha", release: "latest" },
        workflowPaths: [".github/workflows/buildchain-ref-promotion.yml"],
        workflowRefs: ["refs/heads/dev/v3/v3.0"],
      },
    ],
  };
}

function metadata() {
  return {
    name: "@kungfu-tech/buildchain",
    version: "3.0.4",
    repository: { url: "git+https://github.com/kungfu-systems/buildchain.git" },
    gitHead: "60df93f1e632388806bd1249daa392ec7c18cdbd",
    dist: {
      integrity,
      attestations: {
        url: "https://registry.npmjs.org/-/npm/v1/attestations/@kungfu-tech%2fbuildchain@3.0.4",
      },
    },
  };
}

function attestations() {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: "pkg:npm/%40kungfu-tech/buildchain@3.0.4",
        digest: { sha512: subjectSha512 },
      },
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            ref: "refs/heads/dev/v3/v3.0",
            repository: "https://github.com/kungfu-systems/buildchain",
            path: ".github/workflows/buildchain-ref-promotion.yml",
          },
        },
        resolvedDependencies: [
          {
            uri: "git+https://github.com/kungfu-systems/buildchain@refs/heads/dev/v3/v3.0",
            digest: { gitCommit: sourceSha },
          },
        ],
      },
      runDetails: {
        metadata: {
          invocationId:
            "https://github.com/kungfu-systems/buildchain/actions/runs/30716449746/attempts/1",
        },
      },
    },
  };
  return {
    attestations: [
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
          },
        },
      },
    ],
  };
}

function resolvedRelease() {
  return resolveNpmRegistryRelease({
    source: config().sources[0],
    channel: "release",
    packageMetadata: metadata(),
    attestations: attestations(),
  });
}

test("manual pickup binds npm integrity to SLSA source while allowing advisory gitHead", () => {
  const release = resolvedRelease();
  assert.equal(release.sourceSha, sourceSha);
  assert.equal(release.package.gitHead, metadata().gitHead);
  assert.equal(release.registryProvenance.subjectSha512, subjectSha512);
  assert.equal(release.tag, "");
  assert.equal(release.releasePassport, undefined);
});

test("manual pickup rejects provenance that does not bind the package integrity", () => {
  const forged = attestations();
  const statement = JSON.parse(
    Buffer.from(forged.attestations[0].bundle.dsseEnvelope.payload, "base64"),
  );
  statement.subject[0].digest.sha512 = "0".repeat(128);
  forged.attestations[0].bundle.dsseEnvelope.payload = Buffer.from(
    JSON.stringify(statement),
  ).toString("base64");
  assert.throws(
    () =>
      resolveNpmRegistryRelease({
        source: config().sources[0],
        channel: "release",
        packageMetadata: metadata(),
        attestations: forged,
      }),
    /subject must match package integrity/,
  );
});

test("legacy automatic release evidence remains strict", () => {
  assert.throws(
    () =>
      normalizeUpstreamRelease({
        repository: "kungfu-systems/kfd",
        channel: "alpha",
        tag: "v1.0.0-alpha.1",
        tagTargetSha: "1".repeat(40),
        sourceSha: "1".repeat(40),
        package: {
          name: "@kungfu-tech/kfd",
          version: "1.0.0-alpha.1",
          integrity,
        },
        releasePassport: {
          url: "https://github.com/kungfu-systems/kfd/releases/download/v1.0.0-alpha.1/buildchain.release.json",
          sha256: "2".repeat(64),
        },
      }),
    /package gitHead must match sourceSha/,
  );
});

test("manual pickup only creates paused Work after explicit create and returns a true no-op", () => {
  const updatePlan = createManualUpstreamPickupPlan({
    config: config(),
    sourceId: "buildchain",
    channel: "release",
    currentVersion: "3.0.3",
    upstreamRelease: resolvedRelease(),
  });
  assert.equal(updatePlan.automaticTrigger, false);
  assert.equal(updatePlan.runtime.version, "3.0.5-alpha.7");
  assert.equal(updatePlan.resolvedVersion, "3.0.4");
  assert.equal(updatePlan.status, "update-available");
  assert.equal(
    updatePlan.propagationPlan.targets[0].lockPath,
    "buildchain.upstreams/buildchain.release.json",
  );
  const capture = createManualUpstreamPickupCapture({
    plan: updatePlan,
    expectedDownstreamBaseSha: "3".repeat(40),
  });
  assert.equal(capture.work.state.lifecycle, "paused");
  assert.equal(capture.work.state.nextAction.action, "claim");

  const currentPlan = createManualUpstreamPickupPlan({
    config: config(),
    sourceId: "buildchain",
    channel: "release",
    currentVersion: "3.0.4",
    upstreamRelease: resolvedRelease(),
  });
  const noOp = createManualUpstreamPickupCapture({ plan: currentPlan });
  assert.equal(currentPlan.status, "current");
  assert.equal(currentPlan.propagationPlan, null);
  assert.equal(noOp.work, null);
  assert.equal(noOp.nextAction, "none");
});

test("pickup plan CLI is read-only unless an output is requested", () => {
  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-manual-pickup-"),
  );
  const configPath = path.join(cwd, "config.json");
  const metadataPath = path.join(cwd, "metadata.json");
  const attestationsPath = path.join(cwd, "attestations.json");
  fs.writeFileSync(configPath, JSON.stringify(config()));
  fs.writeFileSync(metadataPath, JSON.stringify(metadata()));
  fs.writeFileSync(attestationsPath, JSON.stringify(attestations()));
  const before = fs.readdirSync(cwd).sort();
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        bin,
        "release-propagation",
        "pickup",
        "plan",
        "--config",
        configPath,
        "--source-id",
        "buildchain",
        "--channel",
        "release",
        "--current-version",
        "3.0.3",
        "--package-metadata",
        metadataPath,
        "--attestations",
        attestationsPath,
        "--json",
      ],
      { cwd, encoding: "utf8" },
    ),
  );
  assert.equal(result.status, "update-available");
  assert.deepEqual(fs.readdirSync(cwd).sort(), before);
});
