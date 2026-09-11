import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  planPaperScaffold,
  writePaperScaffold,
} from "../packages/core/paper/operations/scaffold.js";

const root = path.resolve(import.meta.dirname, "..");

for (const [version, ref, lockPath] of [
  ["4.1.0-alpha.4", "v4-alpha", ".buildchain/alpha-contract-lock.json"],
  ["4.1.0", "v4", ".buildchain/contract-lock.json"],
]) {
  test(`paper scaffold binds ${version} to the ${ref} runtime channel`, (t) => {
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "paper-scaffold-channel-"),
    );
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const options = {
      cwd,
      buildchainRoot: root,
      buildchainVersion: version,
      name: "channel-test",
      packageName: "@example/channel-test",
      repository: "example/channel-test",
    };
    assert.equal(writePaperScaffold(planPaperScaffold(options)).ok, true);
    const authority = JSON.parse(
      fs.readFileSync(
        path.join(cwd, ".buildchain/paper/provisioning-authority.json"),
        "utf8",
      ),
    );
    const lockBytes = fs.readFileSync(path.join(cwd, lockPath), "utf8");
    const lock = JSON.parse(lockBytes);
    assert.equal(authority.runtime.ref, ref);
    assert.equal(authority.admission.acceptedRef, ref);
    assert.equal(authority.admission.contractLockPath, lockPath);
    assert.equal(
      authority.admission.contractLockDigest,
      `sha256:${createHash("sha256").update(lockBytes).digest("hex")}`,
    );
    assert.equal(lock.buildchain.ref, ref);
    assert.equal(authority.runtime.resolvedSha, lock.buildchain.resolvedSha);
    assert.equal(
      writePaperScaffold(planPaperScaffold(options)).idempotent,
      true,
    );
  });
}
