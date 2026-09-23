import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { qualifyPromotionCandidate } from "../packages/core/release/promotion/candidate.js";
import { assertHistoricalPromotionEffects } from "../packages/core/release/promotion/compatibility-qualification.js";
const runtime = "a".repeat(40),
  prior = "b".repeat(40);
function input(values) {
  return {
    request: {
      "resume-candidate-run-id": "123",
      "historical-inputs-json": JSON.stringify({
        schema: "buildchain.historical-promotion/v1",
        inputs: values,
      }),
    },
    runtimeSha: runtime,
    intent: { channel: "alpha" },
  };
}
test("historical runtime pins reject mismatch before recovery or publication", async (t) => {
  let calls = 0;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-pin-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const passport = path.join(temporary, "passport.json");
  fs.writeFileSync(passport, JSON.stringify({ buildchain: { sha: prior } }));
  const candidate = { paths: { passport } };
  const deps = {
    recover() {
      calls++;
      return candidate;
    },
  };
  await assert.rejects(
    qualifyPromotionCandidate(
      input({ "resume-buildchain-runtime-sha": prior }),
      deps,
    ),
    /exact pin/,
  );
  assert.equal(calls, 0);
  assert.equal(
    await qualifyPromotionCandidate(
      input({
        "resume-buildchain-runtime-sha": runtime,
        "resume-expected-candidate-runtime-sha": prior,
      }),
      deps,
    ),
    candidate,
  );
  await assert.rejects(
    qualifyPromotionCandidate(
      input({ "resume-expected-candidate-runtime-sha": runtime }),
      deps,
    ),
    /runtime pin/,
  );
});
test("a retained command cannot disappear silently before its adapter is implemented", () => {
  assert.throws(
    () =>
      assertHistoricalPromotionEffects(
        input({ "publication-commit-command": "do-something" }).request,
      ),
    /not implemented: publication-commit-command/,
  );
  assert.doesNotThrow(() =>
    assertHistoricalPromotionEffects(
      input({ "github-release-title": "Release" }).request,
    ),
  );
});
