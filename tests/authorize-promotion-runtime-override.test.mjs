import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import authorization from "../scripts/authorize-promotion-runtime-override.cjs";

const context = {
  eventName: "workflow_dispatch",
  actor: "maintainer",
  repo: { owner: "kungfu-systems", repo: "buildchain" },
};
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ROOT_A = `sha256:${"a".repeat(64)}`;
const ROOT_B = `sha256:${"b".repeat(64)}`;

test("promotion runtime override requires a trusted manual actor", async () => {
  const requests = [];
  const github = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async (request) => {
          requests.push(request);
          return { data: { permission: "maintain" } };
        },
      },
    },
  };
  assert.deepEqual(
    await authorization.authorizePromotionRuntimeOverride({ github, context }),
    { actor: "maintainer", permission: "maintain" },
  );
  assert.deepEqual(requests, [
    {
      owner: "kungfu-systems",
      repo: "buildchain",
      username: "maintainer",
    },
  ]);
  await assert.rejects(
    authorization.authorizePromotionRuntimeOverride({
      github,
      context: { ...context, eventName: "pull_request" },
    }),
    /only allowed for trusted workflow_dispatch runs/,
  );
});

test("promotion runtime override rejects read-only actors", async () => {
  const github = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => ({
          data: { user: { permissions: "read" } },
        }),
      },
    },
  };
  await assert.rejects(
    authorization.authorizePromotionRuntimeOverride({ github, context }),
    /requires write, maintain, or admin permission; actor has read/,
  );
});

test("promotion runtime override normalizes GitHub's collaborator permission object", async () => {
  const github = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => ({
          data: {
            permission: "write",
            user: {
              permissions: {
                admin: false,
                maintain: false,
                pull: true,
                push: true,
                triage: true,
              },
            },
          },
        }),
      },
    },
  };
  assert.deepEqual(
    await authorization.authorizePromotionRuntimeOverride({ github, context }),
    { actor: "maintainer", permission: "write" },
  );
});

test("promotion runtime override roots provider reachability and source persistence evidence", async () => {
  const consumerRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-runtime-override-consumer-"),
  );
  fs.mkdirSync(path.join(consumerRoot, ".github/workflows"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(consumerRoot, ".buildchain/evidence"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(consumerRoot, ".github/workflows/release.yml"),
    "on:\n  workflow_dispatch:\n    inputs:\n      buildchain-ref:\n        default: v4-alpha\n",
  );
  const policyPath = path.join(
    consumerRoot,
    ".buildchain/evidence/v4-consumer-policy-receipt.json",
  );
  fs.writeFileSync(
    policyPath,
    `${JSON.stringify({
      receiptRoot: ROOT_A,
      receipt: {
        contractLocks: {
          stable: { root: ROOT_A },
          alpha: { root: ROOT_B },
        },
      },
    })}\n`,
  );
  const requests = [];
  const github = {
    rest: {
      git: {
        getRef: async (request) => {
          requests.push(request.ref);
          return {
            data: {
              ref: `refs/${request.ref}`,
              object: {
                sha: request.ref.endsWith("v4-alpha") ? SHA_B : SHA_A,
              },
            },
          };
        },
      },
      repos: {
        getCollaboratorPermissionLevel: async () => ({
          data: { permission: "maintain" },
        }),
        compareCommitsWithBasehead: async () => ({
          data: { status: "behind" },
        }),
      },
    },
  };
  const outputPath = path.join(
    consumerRoot,
    ".buildchain/evidence/runtime.json",
  );
  const result = await authorization.authorizePromotionRuntimeOverride({
    github,
    context,
    request: {
      consumerRoot,
      runtimeModulePath: path.resolve(
        "packages/core/v4-runtime-ref-resume-authority.js",
      ),
      consumerPolicyReceiptPath: policyPath,
      consumerPolicyReceiptRoot: ROOT_A,
      sourceSha: SHA_A,
      sourceTreeSha: SHA_B,
      requestedRef: SHA_B,
      resolvedRuntimeSha: SHA_B,
      reason: "resume the failed platform tail",
      mode: "resume",
      authorizedAt: "2026-08-14T02:00:00.000Z",
      outputPath,
    },
  });
  assert.equal(result.receipt.status, "authorized");
  assert.equal(result.receipt.runtime.sha, SHA_B);
  assert.equal(result.persistenceScan.status, "passed");
  assert.ok(requests.includes("heads/v4-alpha"));
  assert.equal(
    JSON.parse(fs.readFileSync(outputPath, "utf8")).receiptRoot,
    result.receiptRoot,
  );
});
