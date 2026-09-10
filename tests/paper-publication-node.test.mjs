import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  publishedPackageMatches,
  resolvePublishedTag,
  readPublishedPaper,
} from "../packages/core/paper/publication/readback.js";
import {
  resolvePaperTarget,
} from "../packages/core/paper/publication/target.js";
import { lockPaperPublicationTarget } from "../packages/core/paper/publication/target.js";
import {
  validatePaperPropagationConfig,
  capturePaperPropagation,
} from "../packages/core/paper/publication/propagation.js";
const sha = "a".repeat(40),
  version = "4.1.0-alpha.0",
  tag = `v${version}`;
const env = {
  packageName: "@acme/paper",
  packageVersion: version,
  sourceSha: sha,
  releaseTag: tag,
  passportPath: "passport.json",
};
const fact = { version, gitHead: sha, dist: { integrity: "sha512-example" } };
async function workspace(fn) {
  const old = process.cwd(),
    root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-paper-node-"));
  process.chdir(root);
  try {
    return await fn(root);
  } finally {
    process.chdir(old);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test("paper release has one public API with read-only candidate, independent authority and admitted publication", () => {
  const workflow = YAML.parse(
    fs.readFileSync(".github/workflows/public-release-paper.yml", "utf8"),
  );
  assert.deepEqual(Object.keys(workflow.jobs), [
    "publication-candidate",
    "publication-authority",
    "publish",
  ]);
  assert.equal(
    workflow.jobs["publication-candidate"].permissions.contents,
    "read",
  );
  assert.equal(
    workflow.jobs["publication-authority"].uses,
    "./.github/workflows/.release-authority.yml",
  );
  assert.equal(workflow.jobs.publish.permissions["id-token"], "write");
  assert.equal(workflow.jobs.publish.permissions.contents, "read");
  assert.match(workflow.jobs.publish.if, /!inputs.dry-run/);
  assert.equal(
    workflow.on.workflow_call.secrets.BUILDCHAIN_PROMOTION_TOKEN,
    undefined,
  );
  assert.equal(
    workflow.on.workflow_call.outputs["package-name"].value,
    "${{ jobs.publication-candidate.outputs.package-name }}",
  );
  assert.ok(
    !fs.existsSync(".github/workflows/public-release-paper-sealed.yml"),
  );
  assert.deepEqual(
    workflow.jobs.publish.steps.slice(2).map((s) => s.id),
    ["admit-candidate", "publish-candidate", "settle-publication"],
  );
  assert.ok(workflow.jobs.publish.steps.every((s) => s.uses && !s.run));
  const publish = YAML.parse(
    fs.readFileSync("actions/paper/candidate/publish/action.yml", "utf8"),
  );
  const promote = publish.runs.steps.find((s) => s.id === "promote");
  assert.equal(promote.with["publish-auth"], "trusted-publishing");
  assert.match(
    promote.with["publish-sealed-bundle-manifest"],
    /sealed-bundle-manifest/,
  );
  assert.doesNotMatch(promote.with.token, /github.token/);
});
test("paper write authority and publication target reject absent credentials and unexpected source", () => {
  const admission = YAML.parse(fs.readFileSync("actions/paper/candidate/admit/action.yml", "utf8"));
  const credential = admission.runs.steps.find(step => step.id === "credential");
  assert.equal(credential.with["require-token"], "true");
  assert.equal(credential.with["workflow-token"], undefined);
  assert.equal(credential.with["permission-contents"], "write");
  assert.throws(
    () =>
      resolvePaperTarget({
        ref: "dev/v4/v4.1",
        sha: sha,
      }),
    /alpha or release/,
  );
  assert.throws(
    () =>
      resolvePaperTarget(
        { ref: "alpha/v4/v4.1", sha: sha },
        () => "b".repeat(40),
      ),
    /differs/,
  );
});
test("publication gate refuses to replace a differently bound source and propagates provider failures", async () => {
  const context = { repo: { owner: "acme", repo: "paper" } },
    outputs = [],
    writes = [];
  const settings = {
    channel: "alpha",
    ref: "alpha/v4/v4.1",
    sha: sha,
    version: version,
  };
  const github = {
    rest: {
      git: {
        getRef: async () => ({ data: { object: { sha: "b".repeat(40) } } }),
        updateRef: async (x) => writes.push(x),
        createRef: async (x) => writes.push(x),
      },
    },
  };
  const core = { setOutput: (...x) => outputs.push(x) };
  await assert.rejects(
    lockPaperPublicationTarget({ github, repository: "acme/paper", target: settings, version }),
    /different source/,
  );
  assert.equal(writes.length, 0);
  assert.equal(outputs.length, 0);
  github.rest.git.getRef = async () => {
    const error = new Error("denied");
    error.status = 403;
    throw error;
  };
  await assert.rejects(
    lockPaperPublicationTarget({ github, repository: "acme/paper", target: settings, version }),
    /denied/,
  );
  assert.equal(writes.length, 0);
  github.rest.git.getRef = async () => {
    const error = new Error("missing");
    error.status = 404;
    throw error;
  };
  github.rest.git.getRef = async () => {
    if (writes.length) return { data: { object: { sha } } };
    throw Object.assign(new Error("missing"), { status: 404 });
  };
  const locked = await lockPaperPublicationTarget({ github, repository: "acme/paper", target: settings, version });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].sha, sha);
  assert.equal(
    writes[0].ref,
    `refs/heads/publish-gate/alpha/v4/v4.1/${version}`,
  );
  assert.equal(locked.locked, true);
});
test("npm readback requires coherent version, gitHead and integrity; tag selection handles annotated refs exactly", () => {
  assert.ok(publishedPackageMatches(fact, env));
  for (const value of [
    { ...fact, version: "4.0.0" },
    { ...fact, gitHead: "b".repeat(40) },
    { ...fact, dist: { integrity: "" } },
  ])
    assert.ok(!publishedPackageMatches(value, env));
  assert.equal(
    resolvePublishedTag(
      `${"b".repeat(40)}\trefs/tags/${tag}\n${sha}\trefs/tags/${tag}^{}\n`,
      tag,
    ),
    sha,
  );
  assert.throws(
    () =>
      resolvePublishedTag(
        `${sha}\trefs/tags/${tag}\n${sha}\trefs/tags/${tag}`,
        tag,
      ),
    /ambiguous/,
  );
  assert.throws(
    () => resolvePublishedTag(`${sha}\trefs/tags/other`, tag),
    /ambiguous/,
  );
});
test("paper readback retries boundedly and emits facts only after the published tag matches", async () =>
  workspace(async () => {
    let attempts = 0,
      waits = 0;
    const result = await readPublishedPaper({ ...env, workspace: process.cwd() }, {
      request: async (url) => {
        assert.equal(
          url,
          `https://registry.npmjs.org/%40acme%2Fpaper/${version}`,
        );
        attempts++;
        return {
          ok: true,
          json: async () =>
            attempts === 1 ? { ...fact, gitHead: "b".repeat(40) } : fact,
        };
      },
      wait: async (ms) => {
        assert.equal(ms, 5000);
        waits++;
      },
      execute: () => `${sha}\trefs/tags/${tag}`,
    });
    assert.equal(result.gitHead, sha);
    assert.equal(attempts, 2);
    assert.equal(waits, 1);
    assert.ok(fs.existsSync(".buildchain/published-package.json"));
  }));
test("incoherent registry and substituted tag cannot emit publication evidence", async () =>
  workspace(async () => {
    let attempts = 0;
    await assert.rejects(
      readPublishedPaper({ ...env, workspace: process.cwd() }, {
        request: async () => {
          attempts++;
          return { ok: false };
        },
        wait: async () => {},
        execute: () => {
          throw Error("tag lookup before registry");
        },
      }),
      /bounded retry/,
    );
    assert.equal(attempts, 6);
    assert.ok(!fs.existsSync(".buildchain/published-package.json"));
    await assert.rejects(
      readPublishedPaper({ ...env, workspace: process.cwd() }, {
        request: async () => ({ ok: true, json: async () => fact }),
        execute: () => `${"b".repeat(40)}\trefs/tags/${tag}`,
      }),
      /tag target/,
    );
    assert.ok(!fs.existsSync(".buildchain/published-package.json"));
  }));
test("paper propagation rejects unknown fields, duplicate targets and missing source binding", () => {
  const config = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-paper-release-propagation",
    sourceNode: "paper",
    graph: {},
    targets: ["site-a", "site-b"],
  };
  assert.equal(validatePaperPropagationConfig(config), config);
  for (const value of [
    { ...config, extra: true },
    { ...config, sourceNode: "" },
    { ...config, targets: ["site-a", "site-a"] },
    { ...config, targets: ["site-b", "site-a"] },
  ])
    assert.throws(() => validatePaperPropagationConfig(value));
});
test("optional propagation config treats only exact provider 404 as unconfigured", async () => {
  const outputs = [],
    calls = [];
  const settings = { repository: "acme/paper", sourceSha: sha };
  const github = {
    rest: {
      repos: {
        getContent: async (args) => {
          calls.push(args);
          const error = new Error("missing");
          error.status = 404;
          throw error;
        },
      },
    },
  };
  const result = await capturePaperPropagation({ ...settings, github });
  assert.deepEqual(result, { configured: false });
  assert.equal(calls[0].ref, sha);
  github.rest.repos.getContent = async () => {
    const error = new Error("denied");
    error.status = 403;
    throw error;
  };
  await assert.rejects(
    capturePaperPropagation({ ...settings, github }),
    /denied/,
  );
  assert.equal(outputs.length, 0);
});
