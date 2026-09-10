import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(
  new URL("../packages/core/release/commands/resume-from-candidate-run.mjs", import.meta.url),
  "utf8",
);

test("candidate recovery forwards the sealed v4 publication evidence", () => {
  for (const name of [
    "release-candidate-stage-capsules-path",
    "release-candidate-publication-qualification-path",
  ]) {
    assert.match(source, new RegExp(`"${name}": result\\.paths\\.`));
  }
  const recovery = fs.readFileSync(new URL("../packages/core/release/recovery/candidate.js", import.meta.url), "utf8");
  assert.match(recovery, /stageCapsules: stageCapsuleFile\s*\?/u);
  assert.match(recovery, /publicationQualification: publicationQualificationFile\s*\?/u);
});
