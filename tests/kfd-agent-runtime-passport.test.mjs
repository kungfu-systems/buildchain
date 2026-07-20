import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

import {
  KFD_AGENT_RUNTIME_PASSPORT_CONTRACT,
  KFD_AGENT_RUNTIME_WITNESS_CONTRACT,
  createKfdAgentRuntimePassportEvidence,
  validateKfdAgentRuntimePassportEvidence,
} from "../packages/core/kfd-agent-runtime-passport.js";
import { createReleasePassport } from "../packages/core/release-passport.js";

const require = createRequire(import.meta.url);
const SOURCE_SHA = "e20015bca84dbcede967681e2988f9296b68b075";
const BUILDCHAIN_BIN = path.resolve("bin/buildchain.mjs");

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function tempDir(name) {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), `buildchain-runtime-passport-${name}-`),
  );
}

function validKfdReport() {
  const packageRoot = path.dirname(
    require.resolve("@kungfu-tech/kfd-agent-runtime/package.json"),
  );
  const report = JSON.parse(
    fs.readFileSync(
      path.join(
        packageRoot,
        "verifier/fixtures/agent-runtime/valid-state-machine-report.json",
      ),
      "utf8",
    ),
  );
  report.adapter.sourceCommit = SOURCE_SHA;
  return report;
}

function createFixture(name, mutate = () => {}) {
  const cwd = tempDir(name);
  const report = validKfdReport();
  const artifactName = "kungfu-kfd-agent-runtime";
  const artifactSha256 = report.adapter.artifactDigest.replace(/^sha256:/, "");
  const witness = {
    schemaVersion: 1,
    contract: KFD_AGENT_RUNTIME_WITNESS_CONTRACT,
    id: "kungfu-runtime-canary",
    product: {
      id: "libkungfu-kfd-agent-runtime",
      repository: "kungfu-systems/kungfu",
    },
    source: {
      sha: SOURCE_SHA,
      tree: "4d046c82cff65115daa5e47483169ea38d50b995",
      projectCut:
        "sha256:90edaa8dca6ce24d4efabc21c7b06c954005255b18c1397f9b0ae5dc7f7449f2",
    },
    plan: {
      profile: {
        id: report.profile.id,
        version: report.profile.version,
        manifestDigest: report.profile.manifestDigest,
      },
      suite: {
        id: report.suite.id,
        version: report.suite.version,
        vectorRoot: report.suite.vectorRoot,
      },
      requiredPlatforms: [
        { os: report.platform.os, arch: report.platform.arch },
      ],
      claimLevel: "independently-verified",
      verification: {
        authority: "@kungfu-tech/kfd",
        mode: "packaged-offline-wasm",
      },
    },
    reports: [
      {
        id: "darwin-arm64",
        report: { path: "evidence/kfd-report.json", sha256: "" },
        artifact: { name: artifactName, sha256: artifactSha256 },
      },
    ],
    nonClaims: [
      "Experimental results are non-normative.",
      "No external adoption is inferred.",
    ],
  };
  const artifacts = [
    {
      name: artifactName,
      sha256: artifactSha256,
      size: 1,
      platform: `${report.platform.os}-${report.platform.arch}`,
    },
  ];
  mutate({ witness, report, artifacts });
  const reportPath = path.join(cwd, "evidence", "kfd-report.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(reportPath, reportText);
  witness.reports[0].report.sha256 = sha256Text(reportText);
  return { cwd, witness, report, artifacts };
}

test("Buildchain independently verifies Runtime 100 and binds the exact release artifact", () => {
  const fixture = createFixture("passing");
  const gate = createKfdAgentRuntimePassportEvidence({
    cwd: fixture.cwd,
    artifacts: fixture.artifacts,
    witnesses: [fixture.witness],
  });
  assert.equal(
    gate.passportSection.contract,
    KFD_AGENT_RUNTIME_PASSPORT_CONTRACT,
  );
  assert.equal(gate.passportSection.status, "passed");
  assert.equal(gate.passportSection.witnesses[0].claims[0].status, "passed");
  assert.equal(gate.passportSection.witnesses[0].claims[1].status, "passed");
  assert.equal(
    gate.passportSection.witnesses[0].claims[2].status,
    "not-claimed",
  );
  assert.equal(
    gate.passportSection.witnesses[0].reports[0].experimental.normative,
    false,
  );
  assert.deepEqual(
    validateKfdAgentRuntimePassportEvidence(gate.passportSection, {
      artifacts: fixture.artifacts,
    }),
    [],
  );

  const passport = createReleasePassport({
    repository: "kungfu-systems/kungfu",
    tag: "v4.0.0-alpha.0",
    sourceSha: SOURCE_SHA,
    assets: fixture.artifacts,
    kfdAgentRuntime: gate,
  });
  assert.equal(passport["kfd-agent-runtime"].status, "passed");
  assert.equal(passport.evidence.kfdAgentRuntime, "kfd-agent-runtime");
});

test("embedded Passport verification rejects a stale suite claim after collection", () => {
  const fixture = createFixture("embedded-stale-suite");
  const gate = createKfdAgentRuntimePassportEvidence({
    cwd: fixture.cwd,
    artifacts: fixture.artifacts,
    witnesses: [fixture.witness],
  });
  const section = structuredClone(gate.passportSection);
  section.witnesses[0].plan.suite.vectorRoot = `sha256:${"a".repeat(64)}`;
  const issues = validateKfdAgentRuntimePassportEvidence(section, {
    artifacts: fixture.artifacts,
  });
  assert.ok(
    issues.some((entry) =>
      entry.code.endsWith(".suite.vectorRoot"),
    ),
    JSON.stringify(issues, null, 2),
  );
  assert.ok(
    issues.some((entry) => entry.code.endsWith(".claims.tested")),
    JSON.stringify(issues, null, 2),
  );
});

test("collect github-release accepts a KFD Agent Runtime witness", () => {
  const fixture = createFixture("cli");
  const witnessPath = path.join(fixture.cwd, "passport.witness.json");
  fs.writeFileSync(
    witnessPath,
    `${JSON.stringify(fixture.witness, null, 2)}\n`,
  );
  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [
        BUILDCHAIN_BIN,
        "collect",
        "github-release",
        "--tag",
        "v4.0.0-alpha.0",
        "--repository",
        "kungfu-systems/kungfu",
        "--source-sha",
        SOURCE_SHA,
        "--assets-json",
        JSON.stringify(fixture.artifacts),
        "--kfd-agent-runtime-witness-json",
        witnessPath,
        "--output-dir",
        ".buildchain/release-passport",
        "--json",
      ],
      { cwd: fixture.cwd, encoding: "utf8" },
    ),
  );
  assert.equal(output.passport["kfd-agent-runtime"].status, "passed");
  assert.equal(output.checkReport.ok, true);
});

test("reference-adopter remains explicit and requires independent review evidence", () => {
  const fixture = createFixture("reference-adopter", ({ witness }) => {
    witness.plan.claimLevel = "reference-adopter";
    witness.adoption = {
      referenceAdopter: {
        contract: "kungfu-buildchain-reference-adopter-evidence/v1",
        reviewedSourceSha: SOURCE_SHA,
        reviewer: {
          id: "kungfu-origin",
          source: "github.com/kungfu-systems/maintainer-review",
        },
        reviewRoot:
          "sha256:7b019ad5629bafd9861fc19f7ac60f9bcc996f5171f286e7e9f7bf0905965183",
        publicUrl: "https://github.com/kungfu-systems/kungfu/pull/1169",
      },
    };
  });
  const gate = createKfdAgentRuntimePassportEvidence({
    cwd: fixture.cwd,
    artifacts: fixture.artifacts,
    witnesses: [fixture.witness],
  });
  assert.equal(gate.passportSection.status, "passed");
  assert.equal(gate.passportSection.witnesses[0].claims[2].status, "passed");
  assert.equal(gate.passportSection.witnesses[0].claims[2].inferred, false);
  assert.equal(
    gate.passportSection.witnesses[0].claims[3].status,
    "not-claimed",
  );
});

for (const fixture of [
  {
    name: "stale-suite",
    mutate: ({ witness }) => {
      witness.plan.suite.vectorRoot = `sha256:${"a".repeat(64)}`;
    },
    code: "kfd-agent-runtime.report.suite.vectorRoot",
  },
  {
    name: "wrong-artifact",
    mutate: ({ artifacts }) => {
      artifacts[0].sha256 = "b".repeat(64);
    },
    code: "kfd-agent-runtime.artifact.binding",
  },
  {
    name: "partial-platform",
    mutate: ({ witness }) => {
      witness.plan.requiredPlatforms.push({ os: "linux", arch: "x64" });
    },
    code: "kfd-agent-runtime.platform.missing",
  },
  {
    name: "experimental-as-core",
    mutate: ({ report }) => {
      report.partitions.core = {
        total: 100,
        passed: 100,
        failed: 0,
        status: "pass",
      };
      report.partitions.experimental = {
        total: 0,
        passed: 0,
        failed: 0,
        status: "pass",
      };
    },
    code: "kfd-agent-runtime.verifier.invalid",
  },
  {
    name: "tampered-report",
    mutate: ({ report }) => {
      report.results[0].actual.code = "tampered";
    },
    code: "kfd-agent-runtime.verifier.invalid",
  },
  {
    name: "self-only-verification",
    mutate: ({ witness }) => {
      witness.plan.verification = {
        authority: "runtime-producer",
        mode: "producer-report-only",
      };
    },
    code: "kfd-agent-runtime.independent-verifier-required",
  },
]) {
  test(`KFD Agent Runtime Passport fails closed for ${fixture.name}`, () => {
    const value = createFixture(fixture.name, fixture.mutate);
    const gate = createKfdAgentRuntimePassportEvidence({
      cwd: value.cwd,
      artifacts: value.artifacts,
      witnesses: [value.witness],
    });
    assert.equal(gate.passportSection.status, "failed");
    assert.ok(
      gate.passportSection.witnesses[0].issues.some(
        (entry) => entry.code === fixture.code,
      ),
      JSON.stringify(gate.passportSection.witnesses[0].issues, null, 2),
    );
  });
}

test("externally-adopted cannot be projected without distinct public adopter evidence", () => {
  const fixture = createFixture("external-adoption", ({ witness }) => {
    witness.plan.claimLevel = "externally-adopted";
  });
  const gate = createKfdAgentRuntimePassportEvidence({
    cwd: fixture.cwd,
    artifacts: fixture.artifacts,
    witnesses: [fixture.witness],
  });
  assert.equal(gate.passportSection.status, "failed");
  assert.ok(
    gate.passportSection.witnesses[0].issues.some(
      (entry) => entry.code === "kfd-agent-runtime.reference-adopter-evidence",
    ),
  );
  assert.ok(
    gate.passportSection.witnesses[0].issues.some(
      (entry) => entry.code === "kfd-agent-runtime.external-adoption-evidence",
    ),
  );
});

test("Kungfu consumer canary retains exact merged coordinates and honest claim ceiling", () => {
  const canary = JSON.parse(
    fs.readFileSync(
      path.resolve("fixtures/kfd-agent-runtime-shaped/kungfu-canary.json"),
      "utf8",
    ),
  );
  assert.equal(
    canary.contract,
    "kungfu-buildchain-kfd-agent-runtime-canary/v1",
  );
  assert.equal(canary.source.mergedHead.length, 40);
  assert.equal(
    canary.profile.suiteRoot,
    `sha256:${"1e996b8c43b0b3e38630ccd58acf8a714cbc24b339d3794318347faab9057e5f"}`,
  );
  assert.equal(canary.results.core.passed, 35);
  assert.equal(canary.results.experimental.passed, 65);
  assert.equal(canary.results.experimental.normative, false);
  assert.equal(canary.claimLevel, "independently-verified");
  assert.ok(canary.nonClaims.includes("external-adoption"));
});
