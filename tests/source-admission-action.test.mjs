import assert from "node:assert/strict";
import test from "node:test";
import { admitSource } from "../packages/core/build/source-admission.js";
import { runAction } from "../packages/core/runtime/action-host.js";

test("failed, skipped and missing source checkout cannot inspect or execute source", () => {
  for (const outcome of ["failure", "cancelled", "skipped", "", undefined])
    assert.throws(
      () => admitSource({ outcome }, () => assert.fail("source was accessed")),
      /did not succeed/,
    );
});

test("immutable source admission rejects invalid identity and checkout drift", () => {
  const sha = "a".repeat(40);
  assert.throws(
    () =>
      admitSource({ outcome: "success", expectedSha: "dev/v4/v4.1" }, () =>
        assert.fail(),
      ),
    /exact 40-hex/,
  );
  assert.throws(
    () =>
      admitSource({ outcome: "success", expectedSha: sha }, () =>
        "b".repeat(40),
      ),
    /does not match/,
  );
  assert.deepEqual(
    admitSource(
      { outcome: "success", expectedSha: sha, directory: "source" },
      (command, args) => {
        assert.equal(command, "git");
        assert.deepEqual(args, [
          "-C",
          "source",
          "rev-parse",
          "--verify",
          "HEAD^{commit}",
        ]);
        return sha + "\n";
      },
    ),
    { sha },
  );
});

test("action host awaits business completion and reports rejected promises once", async () => {
  const failures = [];
  await runAction(
    async () => {
      await Promise.resolve();
      throw new Error("admission rejected");
    },
    { setFailed: (message) => failures.push(message) },
  );
  assert.deepEqual(failures, ["admission rejected"]);
});
