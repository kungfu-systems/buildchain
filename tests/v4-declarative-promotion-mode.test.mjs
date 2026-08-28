import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const workflow = fs.readFileSync(
  path.resolve(".github/workflows/.release-candidate-promote.yml"),
  "utf8",
);
const publicWorkflow = fs.readFileSync(
  path.resolve(".github/workflows/release-candidate-promote.yml"),
  "utf8",
);
const recoveryWorkflow = fs.readFileSync(
  path.resolve(".github/workflows/buildchain-ref-promotion-recovery.yml"),
  "utf8",
);
const selfPromotionWorkflow = fs.readFileSync(
  path.resolve(".github/workflows/buildchain-ref-promotion.yml"),
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

test("bounded floating bootstrap uses the old private shell with a declarative built-in tail", () => {
  assert.match(
    recoveryWorkflow,
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/\.release-candidate-promote\.yml@alpha\/v4\/v4\.0/u,
  );
  assert.match(recoveryWorkflow, /promotion-shell-ref: \$\{\{ needs\.consumer-admission\.outputs\.shell-call-ref \}\}/u);
  assert.match(recoveryWorkflow, /declarative-release-tail: true/u);
  assert.doesNotMatch(recoveryWorkflow, /channel-finalization-recovery/u);
  assert.doesNotMatch(publicWorkflow, /channel-finalization-recovery/u);
});

test("trusted-publisher durable alpha recovery keeps the official floating shell on the declarative built-in tail", () => {
  const promoteAlphaBlock = selfPromotionWorkflow.match(
    /^  promote-alpha:[\s\S]*?(?=^  promote-stable:)/mu,
  )?.[0];

  assert.ok(promoteAlphaBlock, "expected the promote-alpha job");
  assert.match(
    promoteAlphaBlock,
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/\.?release-candidate-promote\.yml@v4-alpha/u,
  );
  assert.match(
    promoteAlphaBlock,
    /^      publication-publisher-workflow-path: \.github\/workflows\/buildchain-ref-promotion\.yml$/mu,
  );
  assert.match(
    promoteAlphaBlock,
    /^      publication-authority-workflow-path: \.github\/workflows\/\.release-candidate-promote\.yml$/mu,
  );
  assert.doesNotMatch(promoteAlphaBlock, /channel-finalization-recovery/u);
});

test("declarative promotion receipt reads the retained passport hierarchy", () => {
  assert.match(
    workflow,
    /promotion-evidence\/release-candidate\/passport\/release-candidate-passport\.json/,
  );
  assert.doesNotMatch(
    workflow,
    /promotion-evidence\/release-candidate\/release-candidate-passport\.json/,
  );
});

test("legacy publication authority delegates the exact OIDC mutation job without public input drift", () => {
  assert.doesNotMatch(workflow, /authority-job-id:/u);
  assert.match(
    workflow,
    /promote:\n    name: Select declarative or legacy promotion result\n    # buildchain-publication-authority-job: legacy-promote/u,
  );
});
