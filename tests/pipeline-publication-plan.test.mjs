import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { compileConsumerPlan } from "../packages/core/consumer/contract/plan.js";
import {
  planPipelinePublication,
  pipelineExpectedProducts,
  verifyPipelinePublicationPlan,
} from "../packages/core/publication/pipeline/plan.js";
import { assertPipelineStableQualification } from "../packages/core/publication/pipeline/stable.js";
import { applyPipelinePublication } from "../packages/core/publication/pipeline/apply.js";
import {
  readPipelineVersion,
  materializePipelineVersion,
} from "../packages/core/publication/pipeline/version.js";

const sha = "a".repeat(40);
function input(type = "npm") {
  const contract = compileConsumerPlan(
    fs.readFileSync(
      `templates/minimal-consumer/${type}/.buildchain/buildchain.toml`,
      "utf8",
    ),
  );
  return {
    attempt: `attempt-${"a".repeat(64)}`,
    generation: `generation-${"b".repeat(64)}`,
    source: { repository: "example/product", commit: sha },
    runtime: { sha },
    publisher: { sha },
    contract,
    route: contract.channels[1],
    version: "1.0.0-alpha.1",
    sourceTimestamp: "2026-09-13T00:00:00Z",
  };
}

test("one publication plan covers npm, archive and PDF declarations without product-specific entry inputs", () => {
  for (const type of ["npm", "binary", "paper"]) {
    const request = input(type),
      plan = planPipelinePublication(request);
    assert.equal(plan.version, "1.0.0-alpha.1");
    assert.equal(plan.outputs.length, 1);
    assert.equal(plan.outputs[0].id, "main/linux-x64/main");
    assert.deepEqual(plan.phases, ["QUALIFY", "APPLY", "SETTLE"]);
    verifyPipelinePublicationPlan(plan);
    assert.throws(
      () => verifyPipelinePublicationPlan({ ...plan, version: "1.0.1" }),
      /retained root/,
    );
  }
  const request = input();
  request.contract.products[0].platforms.push("windows-x64");
  assert.equal(pipelineExpectedProducts(request.contract).length, 2);
  request.contract.products[0].artifacts[0].filename = "same-package.tgz";
  assert.throws(
    () => pipelineExpectedProducts(request.contract),
    /filenames must be unique/,
  );
});

test("Rust version selection retains alpha and materializes stable; anchored authority cannot be inferred", () => {
  const request = input();
  request.route = request.contract.channels[2];
  const plan = planPipelinePublication(request);
  assert.equal(plan.version, "1.0.0");
  request.contract.version.strategy = "anchored";
  assert.throws(() => planPipelinePublication(request), /Anchored publication/);
  request.version = "1.0.0";
  assert.equal(planPipelinePublication(request).version, "1.0.0");
});

test("publication retains the exact stable policy independently of later configuration mutation", () => {
  const request = input();
  request.contract.stable = compileConsumerPlan(
    fs.readFileSync(".buildchain/buildchain.toml", "utf8"),
  ).stable;
  const plan = planPipelinePublication(request);
  assert.deepEqual(plan.stablePolicy, request.contract.stable);
  request.contract.stable.minimum_soak_seconds = 1;
  assert.equal(plan.stablePolicy.minimum_soak_seconds, 0);
  assert.throws(
    () =>
      verifyPipelinePublicationPlan({
        ...plan,
        stablePolicy: request.contract.stable,
      }),
    /retained root/,
  );
  const { stablePolicy, ...removed } = plan;
  assert.throws(() => verifyPipelinePublicationPlan(removed), /retained root/);
});

test("Alpha stays available and an unadmitted context cannot read stable provider data", async () => {
  const request = input();
  request.contract.stable = compileConsumerPlan(
    fs.readFileSync(".buildchain/buildchain.toml", "utf8"),
  ).stable;
  const alpha = planPipelinePublication(request);
  assert.equal(await assertPipelineStableQualification(alpha), null);
  const stable = planPipelinePublication({
    ...request,
    route: request.contract.channels[2],
  });
  let accessed = false;
  const host = new Proxy(
    {},
    {
      get() {
        accessed = true;
        throw new Error("unexpected provider access");
      },
    },
  );
  await assert.rejects(
    applyPipelinePublication({ plan: stable }, host),
    /Publication context is not from this exact provider execution/,
  );
  assert.equal(accessed, false);
});

test("version materialization touches only declared existing fields and rejects drift and dangerous keys", () => {
  const policy = {
    strategy: "semver",
    files: [
      { path: "package.json", format: "json", key: "version" },
      { path: "Cargo.toml", format: "toml", key: "package.version" },
    ],
  };
  const files = {
    "package.json": '{"version":"1.0.0-alpha.1","scripts":{"build":"keep"}}',
    "Cargo.toml": '[package]\nversion="1.0.0-alpha.1"\nname="keep"\n',
  };
  assert.equal(readPipelineVersion(policy, files), "1.0.0-alpha.1");
  const result = materializePipelineVersion(policy, files, "1.0.0");
  assert.equal(JSON.parse(result.changes[0].content).scripts.build, "keep");
  assert.match(result.changes[1].content, /name = "keep"/);
  assert.deepEqual(
    materializePipelineVersion(policy, files, "1.0.0-alpha.1").changes,
    [],
  );
  assert.throws(
    () =>
      readPipelineVersion(policy, {
        ...files,
        "package.json": '{"version":"1.0.1"}',
      }),
    /same candidate version/,
  );
  assert.throws(
    () =>
      materializePipelineVersion(
        { ...policy, strategy: "anchored" },
        files,
        "1.0.0",
      ),
    /anchored version authority/,
  );
  assert.throws(
    () =>
      readPipelineVersion(
        {
          files: [
            { path: "package.json", format: "json", key: "__proto__.version" },
          ],
        },
        files,
      ),
    /owned document key/,
  );
});
