import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  retainPipelineNativeResult,
  restorePipelineNativeResult,
} from "../packages/core/publication/pipeline/native-retention.js";
import { publicationFile } from "../packages/core/publication/pipeline/files.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

test("native result retention restores exact bytes and refuses corrupted or escaping evidence", async (t) => {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "native-retention-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "input");
  fs.mkdirSync(path.join(input, "payload"), { recursive: true });
  fs.writeFileSync(path.join(input, "index.json"), '{"fixture":true}');
  fs.writeFileSync(
    path.join(input, "payload", "app.zip"),
    "fixture signed bytes",
  );
  const files = new Map();
  const archive = {
    put: async (bytes, options) => {
      const file = path.join(root, options.name);
      fs.writeFileSync(file, bytes);
      const observed = publicationFile(file);
      files.set(observed.digest, Buffer.from(bytes));
      return { digest: observed.digest, size: observed.size };
    },
    read: async (handle) => files.get(handle.digest),
  };
  const retained = await retainPipelineNativeResult(archive, input);
  const restored = await restorePipelineNativeResult(
    archive,
    retained,
    path.join(root, "restored"),
  );
  assert.equal(
    fs.readFileSync(path.join(restored, "payload/app.zip"), "utf8"),
    "fixture signed bytes",
  );
  for (const invalid of [
    "../escape",
    "/absolute",
    "nested/../../escape",
    "a\\b",
    "a//b",
  ]) {
    const { root: unused, ...body } = structuredClone(retained);
    body.files[0].file = invalid;
    await assert.rejects(
      restorePipelineNativeResult(
        archive,
        { ...body, root: recordDigest(body) },
        path.join(root, "invalid"),
      ),
      /escapes/,
    );
  }
  files.set(retained.files[0].handle.digest, Buffer.from("corrupted"));
  await assert.rejects(
    restorePipelineNativeResult(
      archive,
      retained,
      path.join(root, "corrupted"),
    ),
    /differ from/,
  );
  fs.symlinkSync(path.join(input, "index.json"), path.join(input, "link"));
  await assert.rejects(
    retainPipelineNativeResult(archive, input),
    /links and special files/,
  );
});
