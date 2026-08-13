import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createDurableTransactionOperations,
  createRefMutationOperations,
} from "../actions/promote-buildchain-ref/lib.js";
import {
  promoteAlphaChannel,
  publishAlphaCandidate,
  selectAlphaCandidate,
} from "../actions/promote-buildchain-ref/internal/promote-alpha-channel.js";
import { promoteMajorChannel } from "../actions/promote-buildchain-ref/internal/promote-major-channel.js";
import { promoteReleaseChannel } from "../actions/promote-buildchain-ref/internal/promote-release-channel.js";
import { createDurableTransactionOperations as createDurableTransactionOperationsModule } from "../actions/promote-buildchain-ref/internal/durable-transaction-operations.js";
import { createVersionStateOperations } from "../actions/promote-buildchain-ref/internal/version-state-operations.js";

const root = path.resolve(import.meta.dirname, "..");

test("promotion facade delegates to independently owned channel modules", () => {
  assert.equal(typeof promoteMajorChannel, "function");
  assert.equal(typeof promoteAlphaChannel, "function");
  assert.equal(typeof promoteReleaseChannel, "function");
  assert.equal(typeof createVersionStateOperations, "function");
  assert.equal(typeof createDurableTransactionOperations, "function");
  assert.equal(typeof createDurableTransactionOperationsModule, "function");
  const facade = fs.readFileSync(
    path.join(root, "actions/promote-buildchain-ref/lib.js"),
    "utf8",
  );
  for (const channel of ["major", "alpha", "release"]) {
    assert.match(
      facade,
      new RegExp(`from \\"\\./internal/promote-${channel}-channel\\.js\\"`),
    );
    assert.doesNotMatch(
      facade,
      new RegExp(
        `function promote${channel[0].toUpperCase()}${channel.slice(1)}Channel`,
      ),
    );
    const moduleLines = fs
      .readFileSync(
        path.join(
          root,
          `actions/promote-buildchain-ref/internal/promote-${channel}-channel.js`,
        ),
        "utf8",
      )
      .split("\n").length;
    assert.ok(
      moduleLines <= 600,
      `${channel} channel module is ${moduleLines} lines`,
    );
  }
});

test("alpha recovery selects the exact advanced publication transaction before an older contained transaction", () => {
  const oldTransaction = {
    version: "3.0.9-alpha.12",
    exact_tag: "v3.0.9-alpha.12",
    release_sha: "a".repeat(40),
  };
  const advancedPublicationTransaction = {
    version: "3.0.9-alpha.13",
    exact_tag: "v3.0.9-alpha.13",
    release_sha: "b".repeat(40),
  };

  assert.deepEqual(
    selectAlphaCandidate(
      { advancedPublicationTransaction },
      {
        explicitAlphaTags: [],
        transactionOpen: true,
        containsTransaction: true,
        settled: false,
        currentAlpha: {
          tag: oldTransaction.exact_tag,
          transaction: oldTransaction,
        },
      },
    ),
    {
      tag: advancedPublicationTransaction.exact_tag,
      transaction: advancedPublicationTransaction,
    },
  );
});

test("alpha recovery keeps an advanced publication bound to its durable sealed bundle", async () => {
  const transaction = {
    version: "3.0.9-alpha.13",
    exact_tag: "v3.0.9-alpha.13",
    release_sha: "b".repeat(40),
    sealed_bundle: { root: `sha256:${"c".repeat(64)}` },
  };
  const executions = [];

  const publication = await publishAlphaCandidate(
    {
      rule: { channel: "alpha", releasePrefix: "v3.0" },
      stripTagPrefix: (tag) => tag.replace(/^v/, ""),
      transactionHasPublishedMaterial: () => true,
      executePublishTransaction: async (options) => executions.push(options),
    },
    { currentAlpha: undefined, alphaPublishDistTag: "alpha" },
    { tag: transaction.exact_tag, transaction },
  );

  assert.equal(publication.alpha.sha, transaction.release_sha);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].version, transaction.version);
  assert.equal(executions[0].releaseSha, transaction.release_sha);
  assert.equal(executions[0].durablePublicationMaterial, transaction);
});

test("ref mutation responsibility plans provider operations without mutating during dry-run", async () => {
  const requests = [];
  const updates = [];
  const octokit = {
    rest: {
      git: {
        listMatchingRefs: async (request) => {
          requests.push(request);
          return request.ref.startsWith("tags/")
            ? { data: [{ ref: "refs/tags/v3.0.2-alpha.4" }] }
            : {
                data: [
                  { ref: "refs/heads/buildchain/release-state/3-0-alpha-4" },
                ],
              };
        },
      },
    },
  };
  const operations = createRefMutationOperations({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: "a".repeat(40),
    dryRun: true,
    rule: { major: 3, minor: 0, releasePrefix: "v3.0" },
    updates,
  });

  assert.equal((await operations.listLineRefs()).length, 2);
  await operations.ensureTag("v3.0.2-alpha.4");
  await operations.updateTag("v3-alpha");
  await operations.updateDefaultBranch("dev/v3/v3.0");

  assert.deepEqual(requests, [
    {
      owner: "kungfu-systems",
      repo: "buildchain",
      ref: "tags/v3.0.",
    },
    {
      owner: "kungfu-systems",
      repo: "buildchain",
      ref: "heads/buildchain/release-state/3-0-",
    },
  ]);
  assert.deepEqual(
    updates.map(({ action }) => action),
    ["dry-run", "dry-run", "dry-run-default-branch"],
  );
});

test("durable transaction responsibility emits an auditable dry-run plan and enforces the expected version", async () => {
  const updates = [];
  const operations = createDurableTransactionOperations({
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: "a".repeat(40),
    targetRef: "alpha/v3/v3.0",
    dryRun: true,
    cwd: process.cwd(),
    publishTransaction: true,
    expectedPublicationVersion: "3.0.2-alpha.4",
    rule: { channel: "alpha", releasePrefix: "v3.0" },
    updates,
  });

  assert.equal(
    await operations.executePublishTransaction({
      version: "3.0.2-alpha.4",
      exactTag: "v3.0.2-alpha.4",
      channel: "alpha",
      line: "v3.0",
      releaseSha: "b".repeat(40),
    }),
    undefined,
  );
  assert.deepEqual(updates, [
    {
      action: "dry-run-publish-transaction",
      version: "3.0.2-alpha.4",
      tag: "v3.0.2-alpha.4",
      publicTag: "v3.0.2-alpha.4",
      sha: "b".repeat(40),
    },
  ]);
  await assert.rejects(
    operations.executePublishTransaction({
      version: "3.0.2-alpha.5",
      exactTag: "v3.0.2-alpha.5",
      channel: "alpha",
      line: "v3.0",
      releaseSha: "c".repeat(40),
    }),
    /expected 3\.0\.2-alpha\.4, got 3\.0\.2-alpha\.5/,
  );
});
