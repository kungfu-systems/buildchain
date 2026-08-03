import assert from "node:assert/strict";
import test from "node:test";
import authorization from "../scripts/authorize-promotion-runtime-override.cjs";

const context = {
  eventName: "workflow_dispatch",
  actor: "maintainer",
  repo: { owner: "kungfu-systems", repo: "buildchain" },
};

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
