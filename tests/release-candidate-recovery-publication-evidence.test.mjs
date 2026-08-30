import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(
  new URL("../scripts/resume-from-candidate-run.mjs", import.meta.url),
  "utf8",
);

test("candidate recovery forwards the sealed v4 publication evidence", () => {
  for (const name of [
    "release-candidate-stage-capsules-path",
    "release-candidate-publication-qualification-path",
  ]) {
    assert.match(source, new RegExp(`"${name}": result\\.paths\\.`));
  }
  assert.match(source, /stageCapsules: stageCapsuleFile \?/u);
  assert.match(source, /publicationQualification: publicationQualificationFile \?/u);
});
