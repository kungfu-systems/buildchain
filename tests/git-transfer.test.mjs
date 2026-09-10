import assert from "node:assert/strict";
import test from "node:test";
import {
  gitTransferRequest,
  transferGit,
} from "../packages/core/providers/sync-git/transfer.mjs";
const coordinates = {
  host: "git.example.test",
  remotePath: "v1/repos",
  repository: "demo",
  ref: "dev/4.1",
};

test("Git transfer uses exact argv and scopes credentials to the provider subprocess", () => {
  const request = gitTransferRequest({
    ...coordinates,
    credential: "https://ci:fixture-password@git.example.test",
  });
  const calls = [];
  transferGit(request, {
    env: { KEEP: "yes" },
    run: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });
  assert.deepEqual(
    calls.map(({ args }) => args),
    [
      ["fetch", "--", "https://git.example.test/v1/repos/demo"],
      ["push", "--", "https://git.example.test/v1/repos/demo", "dev/4.1"],
    ],
  );
  assert.equal(calls[0].options.env.KEEP, "yes");
  assert.equal(
    calls[0].options.env.GIT_CONFIG_KEY_1,
    "http.https://git.example.test/.extraheader",
  );
  assert.equal(calls[0].options.env.GIT_CONFIG_VALUE_0, "");
  assert.equal(calls[0].options.shell, false);
  assert.doesNotMatch(
    JSON.stringify(calls.map(({ args }) => args)),
    /fixture-password|Authorization/u,
  );
  assert.equal(
    gitTransferRequest({ ...coordinates, force: true }).commands[1][1],
    "--force",
  );
});

test("Git provider failures stop before push and never reflect credentials in errors", () => {
  let calls = 0;
  assert.throws(
    () =>
      transferGit(gitTransferRequest(coordinates), {
        run: () => {
          calls++;
          return { status: 128, stderr: "private provider response" };
        },
      }),
    /^Error: remote git fetch failed with status 128$/u,
  );
  assert.equal(calls, 1);
});

test("Git transfer rejects mismatched credentials and unsafe coordinates before effects", () => {
  for (const changes of [
    { host: "evil.test/path" },
    { remotePath: "../repos" },
    { ref: "--all" },
    { ref: "main:other" },
    { repository: "demo?token=value" },
    { credential: "https://ci:password@other.test" },
    { credential: "http://ci:password@git.example.test" },
    { credential: "https://ci:%0apassword@git.example.test" },
  ])
    assert.throws(() => gitTransferRequest({ ...coordinates, ...changes }));
});
