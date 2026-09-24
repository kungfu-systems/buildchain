import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  qualifyHistoricalEvidence,
  verifyHistoricalEvidence,
  historicalEvidencePaths,
} from "../packages/core/release/promotion/historical-evidence.js";

function fixture(t, script) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "historical-evidence-test-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDirectory = path.join(root, "source"),
    candidateDirectory = path.join(root, "candidate");
  fs.mkdirSync(sourceDirectory);
  fs.mkdirSync(path.join(candidateDirectory, "payloads"), { recursive: true });
  fs.writeFileSync(
    path.join(candidateDirectory, "payloads", "artifact.txt"),
    "sealed",
  );
  fs.writeFileSync(path.join(sourceDirectory, "hook.cjs"), script);
  const git = (...args) =>
    execFileSync("git", ["-C", sourceDirectory, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  );
  return {
    context: JSON.stringify({
      schema: "buildchain.historical-promotion/v1",
      inputs: {
        "release-passport-kfd-3-artifact-verify-command": "node hook.cjs",
      },
    }),
    sourceDirectory,
    candidateDirectory,
    sourceSha: git("rev-parse", "HEAD"),
    environment: {
      ...process.env,
      GITHUB_TOKEN: "must-not-reach-hook",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "must-not-reach-hook",
    },
  };
}
const witness =
  'console.log(JSON.stringify({id:"product", exposedSurfaces:[]}));';
test("retained evidence runs in exact source with old payload paths and without publish credentials", (t) => {
  const input = fixture(
    t,
    `const assert=require('node:assert/strict'), fs=require('node:fs');
assert.equal(process.env.GITHUB_TOKEN,undefined); assert.equal(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,undefined);
assert.equal(fs.readFileSync('.buildchain/release-candidate/payloads/artifact.txt','utf8'),'sealed');
${witness}`,
  );
  const receipt = qualifyHistoricalEvidence(input);
  assert.match(receipt.receiptRoot, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(verifyHistoricalEvidence(input), receipt);
  assert.equal(
    historicalEvidencePaths(input.context, input.candidateDirectory).length,
    1,
  );
  assert.equal(
    qualifyHistoricalEvidence(input).receiptRoot,
    receipt.receiptRoot,
    "retry is deterministic",
  );
  fs.appendFileSync(
    path.join(input.candidateDirectory, "payloads/artifact.txt"),
    "changed",
  );
  assert.throws(() => verifyHistoricalEvidence(input), /does not match/);
});
test("evidence rejects nonzero exit, malformed JSON, invalid witness and material mutation", (t) => {
  for (const [script, expected] of [
    ["process.exit(7)", /status 7/],
    ['console.log("not json")', /valid JSON/],
    ['console.log("{}")', /witness id/],
    [
      `require('node:fs').writeFileSync('.buildchain/release-candidate/payloads/artifact.txt','mutated'); ${witness}`,
      /changed qualified/,
    ],
  ])
    assert.throws(
      () => qualifyHistoricalEvidence(fixture(t, script)),
      expected,
    );
});
test("wrong checkout and changed invocation fail before accepting evidence", (t) => {
  const input = fixture(t, witness);
  assert.throws(
    () => qualifyHistoricalEvidence({ ...input, sourceSha: "a".repeat(40) }),
    /exact qualified/,
  );
  qualifyHistoricalEvidence(input);
  const context = JSON.parse(input.context);
  context.inputs["github-release-title"] = "changed";
  assert.throws(
    () =>
      verifyHistoricalEvidence({ ...input, context: JSON.stringify(context) }),
    /does not match/,
  );
});

test("file witnesses bind KFD-1 bytes and KFD-3 declarations without a command", (t) => {
  const input = fixture(t, witness);
  const surface = {
    id: "product-api",
    public: true,
    participantFacing: true,
    availability: "shipped",
  };
  const files = {
    "release-passport-kfd-1-witness-jsons": {
      id: "product",
      surfaces: [
        {
          name: "artifact",
          artifactPath: "artifact.txt",
          expectedSha256: "placeholder",
        },
      ],
    },
    "release-passport-kfd-3-prebuild-witness-jsons": {
      id: "product",
      declaredSurfaces: [surface],
    },
    "release-passport-kfd-3-artifact-witness-jsons": {
      id: "product",
      exposedSurfaces: [surface],
    },
  };
  // Hash the actual payload, then corrupt only the declaration in the negative case.
  files["release-passport-kfd-1-witness-jsons"].surfaces[0].expectedSha256 =
    createHash("sha256").update("sealed").digest("hex");
  input.context = JSON.stringify({
    schema: "buildchain.historical-promotion/v1",
    inputs: Object.fromEntries(
      Object.entries(files).map(([key, value], index) => {
        const file = `evidence-${index}.json`;
        fs.writeFileSync(
          path.join(input.sourceDirectory, file),
          JSON.stringify(value),
        );
        return [key, file];
      }),
    ),
  });
  const receipt = qualifyHistoricalEvidence(input);
  assert.equal(receipt.gates.kfd1.status, "passed");
  assert.equal(receipt.gates.kfd3.status, "passed");
  assert.equal(receipt.gates.kfd2.status, "passed");
  assert.deepEqual(verifyHistoricalEvidence(input), receipt);
  assert.equal(
    qualifyHistoricalEvidence(input).receiptRoot,
    receipt.receiptRoot,
  );
  fs.writeFileSync(
    path.join(input.sourceDirectory, "evidence-2.json"),
    JSON.stringify({ id: "product", exposedSurfaces: [] }),
  );
  assert.throws(
    () => qualifyHistoricalEvidence(input),
    /kfd3 release evidence failed/,
  );
  fs.writeFileSync(
    path.join(input.sourceDirectory, "evidence-2.json"),
    JSON.stringify(files["release-passport-kfd-3-artifact-witness-jsons"]),
  );
  files["release-passport-kfd-1-witness-jsons"].surfaces[0].expectedSha256 =
    "a".repeat(64);
  fs.writeFileSync(
    path.join(input.sourceDirectory, "evidence-0.json"),
    JSON.stringify(files["release-passport-kfd-1-witness-jsons"]),
  );
  assert.throws(
    () => qualifyHistoricalEvidence(input),
    /kfd1 release evidence failed/,
  );
});

test("historical evidence rejects file and symlink escapes", (t) => {
  const input = fixture(t, witness);
  const setPath = (value) => {
    input.context = JSON.stringify({
      schema: "buildchain.historical-promotion/v1",
      inputs: { "release-passport-kfd-2-claim-jsons": value },
    });
  };
  setPath("../outside.json");
  assert.throws(() => qualifyHistoricalEvidence(input), /escapes/);
  fs.symlinkSync(
    input.candidateDirectory,
    path.join(input.sourceDirectory, "escape"),
  );
  setPath("escape/payloads/artifact.txt");
  assert.throws(() => qualifyHistoricalEvidence(input), /symlink escapes/);
});
