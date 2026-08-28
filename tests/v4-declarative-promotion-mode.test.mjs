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

test("protected v4 publication selects the complete transaction and reserves the provider capsule for injected recovery", () => {
  assert.match(
    workflow,
    new RegExp(
      `v4-declarative-promote:[\\s\\S]*?if: \\$\\{\\{[^\\n]*provider-failure-after-capability != ''[^\\n]*${protectedShellPredicate.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}[^\\n]*\\}\\}`,
    ),
  );
  for (const productionJob of [
    "publication-authority",
    "qualification-plan",
    "publication-qualification",
    "legacy-promote",
  ]) {
    assert.match(
      workflow,
      new RegExp(
        `^  ${productionJob}:[\\s\\S]*?^    if: [^\\n]*provider-failure-after-capability == ''`,
        "m",
      ),
    );
  }
  assert.match(workflow, /authority-job-id: legacy-promote/u);
  assert.match(
    workflow,
    /legacy-promote:[\s\S]*publish-transaction: "true"[\s\S]*declarative-release-tail: \$\{\{ inputs\.declarative-release-tail \}\}/u,
  );
});

test("bounded floating bootstrap uses the old private shell with a declarative built-in tail", () => {
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
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/\.?release-candidate-promote\.yml@v4-alpha/u,
  );
  assert.match(
    promoteAlphaBlock,
    /^      publication-publisher-workflow-path: \.github\/workflows\/buildchain-ref-promotion\.yml$/mu,
  );
  assert.match(promoteAlphaBlock, /^      declarative-release-tail: true$/mu);
  assert.doesNotMatch(promoteAlphaBlock, /channel-finalization-recovery/u);
});

test("declarative promotion receipt reads the bundled controller evidence", () => {
  assert.match(
    workflow,
    /promotion-evidence\/release-candidate-passport\.json/,
  );
  assert.doesNotMatch(
    workflow,
    /promotion-evidence\/release-candidate\/passport\/release-candidate-passport\.json/,
  );
});

test("legacy publication authority audits the exact OIDC mutation job", () => {
  assert.match(
    workflow,
    /publication-authority:[\s\S]*?authority-job-id: legacy-promote/u,
  );
  assert.match(
    workflow,
    /promote:\n    name: Select declarative or legacy promotion result\n    # buildchain-publication-authority-job: legacy-promote/u,
  );
});
