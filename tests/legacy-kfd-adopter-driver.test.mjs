import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createAdopterDeliveryGate,
  createGitCommitArtifactProfile,
} from "../packages/core/adopter-delivery-gate.js";
import {
  LEGACY_KFD_ADOPTER_PROTOCOL_ID,
  LEGACY_KFD_ADOPTER_PROTOCOL_VERSION,
  createLegacyKfdAdopterProtocolDriver,
} from "../packages/core/legacy-kfd-adopter-driver.js";
import { generateBuildchainKfdAdopterRelease } from "../scripts/generate-buildchain-kfd-witnesses.mjs";

const sourceSha = "a".repeat(40);
const checkedAt = "2026-08-12T00:00:00.000Z";

async function fixture() {
  const outputDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-legacy-kfd-driver-"),
  );
  const generated = await generateBuildchainKfdAdopterRelease({
    cwd: process.cwd(),
    outputDir,
    sourceSha,
    checkedAt,
    emitOutputs: false,
  });
  const load = (key) =>
    JSON.parse(fs.readFileSync(path.resolve(generated.outputs[key]), "utf8"));
  const adopterManifest = load("kfd-adopter-manifest-json");
  const adopterManifestGate = load("kfd-adopter-manifest-gate-json");
  const legacyProjection = load("kfd-support-matrix-json");
  const request = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-adopter-delivery-request",
    protocol: {
      id: LEGACY_KFD_ADOPTER_PROTOCOL_ID,
      version: LEGACY_KFD_ADOPTER_PROTOCOL_VERSION,
    },
    artifactProfile: {
      id: "buildchain.artifact/git-commit",
      version: "1.0.0",
    },
    project: {
      instanceId: adopterManifest.manifestId,
      adopterId: adopterManifest.adopter.id,
    },
    artifact: structuredClone(adopterManifest.adopter.artifact),
    declaration: legacyProjection,
  };
  return {
    request,
    context: { adopterManifest, adopterManifestGate },
  };
}

function gate() {
  return createAdopterDeliveryGate({
    drivers: [createLegacyKfdAdopterProtocolDriver()],
    artifactProfiles: [createGitCommitArtifactProfile()],
  });
}

test("legacy driver carries the exact existing manifest projection closure", async () => {
  const built = await fixture();
  const first = gate().evaluate(built.request, built.context);
  const replay = gate().evaluate(built.request, built.context);

  assert.equal(first.status, "passed", JSON.stringify(first.issues));
  assert.equal(first.qualifying, false);
  assert.equal(first.selfCertified, false);
  assert.deepEqual(
    first.semanticReport.legacyProjection,
    built.request.declaration,
  );
  assert.equal(
    first.semanticReport.manifestRoot,
    built.context.adopterManifestGate.authority.manifestRoot,
  );
  assert.deepEqual(replay, first);
});

test("legacy driver fails closed on projection and outer artifact substitution", async () => {
  const drifted = await fixture();
  drifted.request.declaration.rows[0].supportStatus = "adopted";
  const driftedResult = gate().evaluate(drifted.request, drifted.context);
  assert.equal(driftedResult.status, "failed");
  assert.ok(
    driftedResult.issues.some(({ code }) => code === "legacy-projection-drift"),
  );

  const substituted = await fixture();
  substituted.request.artifact.root = `sha256:${"f".repeat(64)}`;
  const substitutedResult = gate().evaluate(
    substituted.request,
    substituted.context,
  );
  assert.equal(substitutedResult.status, "failed");
  assert.ok(
    substitutedResult.issues.some(
      ({ code }) => code === "delivery-legacy-artifact-binding-mismatch",
    ),
  );
});

test("legacy driver requires the exact standard authority context", async () => {
  const built = await fixture();
  const result = gate().evaluate(built.request, {});
  assert.equal(result.status, "failed");
  assert.deepEqual(
    result.issues.map(({ code }) => code),
    ["delivery-legacy-verification-context-invalid"],
  );
});
