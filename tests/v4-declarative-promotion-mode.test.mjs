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

test("protected v4 promotion preserves product publication before the declarative Provider Plane", () => {
  assert.doesNotMatch(workflow, /v4-declarative-promote:/u);
  for (const job of [
    "publication-authority",
    "qualification-plan",
    "publication-qualification",
    "legacy-promote",
  ]) {
    const body = workflow.slice(
      workflow.indexOf(`\n  ${job}:`),
      workflow.indexOf("\n  ", workflow.indexOf(`\n  ${job}:`) + 4),
    );
    assert.doesNotMatch(
      body,
      new RegExp(
        protectedShellPredicate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
    );
  }
  assert.match(
    workflow,
    /name: Promote release candidate[\s\S]*?publish-required-artifacts-json:[\s\S]*?declarative-release-tail:/u,
  );
});

test("bounded floating bootstrap uses the legacy private shell with an exact protected binding and declarative built-in tail", () => {
  assert.match(
    recoveryWorkflow,
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/\.release-candidate-promote\.yml@alpha\/v4\/v4\.0/u,
  );
  assert.match(
    recoveryWorkflow,
    /promotion-shell-ref: \$\{\{ needs\.consumer-admission\.outputs\.shell-call-ref \}\}/u,
  );
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
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/\.release-candidate-promote\.yml@v4-alpha/u,
  );
  assert.match(
    promoteAlphaBlock,
    /^      publication-publisher-workflow-path: \.github\/workflows\/buildchain-ref-promotion\.yml$/mu,
  );
  assert.match(promoteAlphaBlock, /^      declarative-release-tail: true$/mu);
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
