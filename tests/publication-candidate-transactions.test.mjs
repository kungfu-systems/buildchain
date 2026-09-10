import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { qualifyPublicationCandidate } from "../packages/core/publication/candidate/qualification.js";
import { collectPublicationEvidence } from "../packages/core/publication/candidate/collection.js";
import { npmPublishDryRun } from "../packages/core/publication/npm/preview.js";
import { previewNpmPublication } from "../packages/core/publication/npm/preview-action.js";

test("candidate failure retains exact stage outcomes and cannot reach package binding", async () => {
  const calls = [],
    observed = [];
  await assert.rejects(
    qualifyPublicationCandidate(
      { cwd: ".", preparePaperPackage: true, verifyCommand: "consumer-check" },
      {
        resolve: async () => ({ command: "build", type: "latex-docker" }),
        hydrate: () => calls.push("hydrate"),
        prove: () => calls.push("prove"),
        session: {
          run: ({ script, strict }) => {
            calls.push([script, strict]);
            throw Object.assign(new Error("consumer rejected"), { status: 17 });
          },
        },
        manifest: () => calls.push("manifest"),
        bind: () => calls.push("bind"),
        observe: (value) => observed.push(value),
      },
    ),
    (error) => error.status === 17,
  );
  assert.deepEqual(calls, ["hydrate", "prove", ["consumer-check", true]]);
  assert.deepEqual(observed[0].outcomes, {
    build: "success",
    verify: "failure",
    manifest: "skipped",
    package: "skipped",
  });
});
test("publication collection preserves failed upload and requires qualified package when configured", () => {
  let evidence;
  collectPublicationEvidence(
    {
      workspace: process.cwd(),
      workingDirectory: ".",
      sourceSha: "a".repeat(40),
      preparePaperPackage: true,
      runtimeOutcomes: ["success", "failure"],
      outcomes: {
        build: "success",
        verify: "skipped",
        manifest: "failure",
        package: "skipped",
      },
      uploadOutcome: "failure",
    },
    (value) => {
      evidence = value;
      return value;
    },
  );
  assert.deepEqual(
    evidence.stages.map((stage) => stage.status),
    ["failure", "success", "skipped", "failure", "failure"],
  );
  assert.deepEqual(evidence.evidenceFiles, []);
  assert.equal(evidence.reason.code, "publication-incomplete");
});
test("npm preview cannot publish and never runs after failed repository verification", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "npm-preview-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "@fixture/paper", version: "4.1.0-alpha.0" }),
  );
  const calls = [],
    env = { PATH: "fixture" };
  const result = npmPublishDryRun(
    { cwd, env },
    {
      execute: (options) => {
        calls.push(options);
        return {
          stdout: JSON.stringify([
            { name: "@fixture/paper", version: "4.1.0-alpha.0", files: [] },
          ]),
        };
      },
    },
  );
  assert.equal(result.dryRun, true);
  assert.equal(result.distTag, "alpha");
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every((call) => call.args.includes("--dry-run") && call.env === env),
  );
  assert.throws(
    () =>
      previewNpmPublication(
        { workspace: cwd, runCheck: true, env },
        {
          verify: () => {
            throw new Error("check failed");
          },
          preview: () => {
            throw new Error("must not run");
          },
        },
      ),
    /check failed/,
  );
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({ private: true, name: "private", version: "1.0.0" }),
  );
  assert.throws(
    () =>
      npmPublishDryRun(
        { cwd },
        { execute: () => assert.fail("private package reached npm") },
      ),
    /private must be false/,
  );
});
