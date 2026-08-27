import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const workflow = fs.readFileSync(
  path.resolve(".github/workflows/.release-candidate-promote.yml"),
  "utf8",
);
const protectedShellPredicate =
  "startsWith(inputs.promotion-shell-ref, 'v4') || inputs.promotion-shell-ref == 'alpha/v4/v4.0'";

test("protected alpha v4 recovery selects only the declarative Provider Plane", () => {
  assert.match(
    workflow,
    new RegExp(`v4-declarative-promote:[\\s\\S]*?if: \\$\\{\\{[^\\n]*${protectedShellPredicate.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}[^\\n]*\\}\\}`),
  );
  for (const legacyJob of ["publication-authority", "qualification-plan", "publication-qualification", "legacy-promote"]) {
    assert.match(
      workflow,
      new RegExp(`^  ${legacyJob}:[\\s\\S]*?^    if: [^\\n]*!\\(startsWith\\(inputs\\.promotion-shell-ref, 'v4'\\) \\|\\| inputs\\.promotion-shell-ref == 'alpha/v4/v4\\.0'\\)`, "m"),
    );
  }
});
