import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { inspectPipelineFileArtifact } from "../packages/core/publication/pipeline/pack.js";

const python = process.platform === "win32" ? "python" : "python3";

function fixture(t, names) {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pipeline-zip-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "Windows product.zip");
  execFileSync(
    python,
    [
      "-c",
      [
        "import json,sys,zipfile",
        "with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:",
        "    for name in json.load(sys.stdin): z.writestr(name, b'product bytes')",
      ].join("\n"),
      file,
    ],
    { input: JSON.stringify(names), stdio: ["pipe", "pipe", "pipe"] },
  );
  return {
    root,
    file,
    expected: { path: path.basename(file), kind: "archive" },
  };
}

test("publication inspects a real Windows ZIP on the qualification host without rewriting it", (t) => {
  const { root, file, expected } = fixture(t, ["bin/工具 executable.exe"]);
  const before = fs.readFileSync(file);
  assert.deepEqual(inspectPipelineFileArtifact(root, expected), {
    file,
    suffix: ".zip",
  });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(root), [path.basename(file)]);
});

for (const name of [
  "../outside",
  "/absolute",
  "C:/absolute",
  "\\absolute",
  "bin\\..\\outside",
  "bin/line\nbreak",
]) {
  test(`publication rejects unsafe ZIP entry ${JSON.stringify(name)}`, (t) => {
    const { root, expected } = fixture(t, [name]);
    assert.throws(
      () => inspectPipelineFileArtifact(root, expected),
      /unsafe or empty paths/,
    );
  });
}

test("publication rejects empty and malformed ZIP archives", (t) => {
  const { root, file, expected } = fixture(t, []);
  assert.throws(
    () => inspectPipelineFileArtifact(root, expected),
    /unsafe or empty paths/,
  );
  fs.writeFileSync(file, "not an archive");
  assert.throws(() => inspectPipelineFileArtifact(root, expected));
});
