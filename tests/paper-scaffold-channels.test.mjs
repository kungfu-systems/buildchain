import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  planPaperScaffold,
  writePaperScaffold,
} from "../packages/core/paper/operations/scaffold.js";
import { consumerWorkflows } from "../packages/core/consumer/contract/entries.js";
const root = path.resolve(import.meta.dirname, "..");
for (const version of ["4.1.0-alpha.4", "4.1.0"]) {
  test(`Paper scaffold from CLI ${version} keeps the shared v4 entry and creates no invented runtime lock`, (t) => {
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "paper-scaffold-channel-"),
    );
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const options = {
      cwd,
      buildchainRoot: root,
      buildchainVersion: version,
      name: "channel-test",
      repository: "example/channel-test",
    };
    assert.equal(writePaperScaffold(planPaperScaffold(options)).ok, true);
    for (const [file, content] of Object.entries(consumerWorkflows()))
      assert.equal(fs.readFileSync(path.join(cwd, file), "utf8"), content);
    assert.deepEqual(fs.readdirSync(path.join(cwd, ".buildchain")), [
      "buildchain.toml",
    ]);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(cwd, "package.json")))
        .devDependencies["@kungfu-tech/buildchain"],
      version,
    );
    assert.equal(
      writePaperScaffold(planPaperScaffold(options)).idempotent,
      true,
    );
  });
}
