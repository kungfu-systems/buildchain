import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  signNativeRequest,
  qualifySigningDelivery,
} from "../packages/core/build/signing/authority-transaction.js";
import { resolveSigningPath } from "../packages/core/build/signing/files.js";

test("native signing admits sealed artifact metadata before effects and seals only verified provider results", async () => {
  const input = {
    profile: "apple-developer-id",
    artifactId: "app",
    workRoot: "/tmp/native-test",
    requestRoot: "/tmp/requests",
    requestPath: "request.json",
  };
  const request = {
    artifact: { id: "app", kind: "mach-o" },
    signature: { entitlementsProfile: "none" },
  };
  const calls = [];
  const dependencies = {
    materialize: () => ({ request }),
    macos: async (value) => {
      calls.push("sign");
      assert.equal(value.artifact, request.artifact);
      assert.equal(value.signature, request.signature);
    },
    seal: () => {
      calls.push("seal");
      return "sealed";
    },
  };
  assert.equal(await signNativeRequest(input, dependencies), "sealed");
  assert.deepEqual(calls, ["sign", "seal"]);
  calls.length = 0;
  await assert.rejects(
    signNativeRequest({ ...input, artifactId: "substitution" }, dependencies),
    /differs/,
  );
  assert.deepEqual(calls, []);
  await assert.rejects(
    signNativeRequest(input, {
      ...dependencies,
      macos: async () => {
        throw Error("provider failed");
      },
    }),
    /provider failed/,
  );
  assert.deepEqual(calls, []);
  await assert.rejects(
    signNativeRequest({ ...input, profile: "unregistered" }, dependencies),
    /Unsupported/,
  );
});

test("signing delivery does not return qualification after a merge or byte verification failure", () => {
  let verified = false;
  assert.throws(
    () =>
      qualifySigningDelivery(
        {},
        {
          merge: () => {
            throw Error("duplicate result");
          },
          verify: () => {
            verified = true;
          },
        },
      ),
    /duplicate result/,
  );
  assert.equal(verified, false);
  assert.throws(
    () =>
      qualifySigningDelivery(
        {},
        {
          merge: () => {},
          verify: () => {
            throw Error("signed payload digest differs");
          },
        },
      ),
    /digest differs/,
  );
});

test("signing request references cannot escape their physical evidence root", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "signing-path-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "root");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "payload"), "sealed");
  fs.writeFileSync(path.join(directory, "outside"), "untrusted");
  assert.equal(
    resolveSigningPath(root, "payload", "Payload"),
    path.join(root, "payload"),
  );
  assert.throws(
    () => resolveSigningPath(root, "../outside", "Payload"),
    /below/,
  );
  fs.symlinkSync(directory, path.join(root, "escape"), "junction");
  assert.throws(
    () => resolveSigningPath(root, "escape/outside", "Payload"),
    /escapes/,
  );
});
