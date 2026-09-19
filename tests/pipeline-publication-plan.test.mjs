import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { parse, stringify } from "smol-toml";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
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

test("asset names use the materialized alpha or stable version and exact platform", () => {
  const request = input("binary");
  const product = request.contract.products[0];
  product.platforms = ["macos-arm64", "macos-x64"];
  product.artifacts[0].filename = "Kungfu-{version}-{platform}.tar.gz";
  const declarationRoots = [];
  for (const [route, version] of [
    [1, "1.0.0-alpha.1"],
    [2, "1.0.0"],
  ]) {
    request.route = request.contract.channels[route];
    const plan = planPipelinePublication(request);
    assert.deepEqual(
      plan.outputs.map((item) => item.filename),
      [
        `Kungfu-${version}-macos-arm64.tar.gz`,
        `Kungfu-${version}-macos-x64.tar.gz`,
      ],
    );
    assert.equal(
      plan.versionSelection.requiredArtifactsRoot,
      recordDigest(plan.outputs),
    );
    verifyPipelinePublicationPlan(plan);
    declarationRoots.push(plan.outputDeclarationRoot);
  }
  assert.equal(
    declarationRoots[0],
    recordDigest(pipelineExpectedProducts(request.contract)),
  );
  assert.equal(declarationRoots[0], declarationRoots[1]);
  assert.equal(
    product.artifacts[0].filename,
    "Kungfu-{version}-{platform}.tar.gz",
  );
});

test("filename templates reject arbitrary expressions and unsafe resolved names", () => {
  const config = parse(
    fs.readFileSync(
      "templates/minimal-consumer/binary/.buildchain/buildchain.toml",
      "utf8",
    ),
  );
  const artifact = config.products[0].artifacts[0];
  artifact.filename = "Kungfu-{version}-{platform}.tar.gz";
  const plan = compileConsumerPlan(stringify(config));
  assert.equal(
    pipelineExpectedProducts(plan, "1.0.0+build.1")[0].filename,
    "Kungfu-1.0.0+build.1-linux-x64.tar.gz",
  );
  for (const filename of [
    "{secret}.tar.gz",
    "${version}.tar.gz",
    "../{version}.tar.gz",
    "$(env).tar.gz",
    "a/{version}.tar.gz",
    "Kungfu-{version}.tar.gz\n",
    1,
  ]) {
    artifact.filename = filename;
    assert.throws(
      () => compileConsumerPlan(stringify(config)),
      /filename.*invalid string/,
    );
  }
  for (const version of ["../escape", "{version}", "a".repeat(255)])
    assert.throws(
      () => pipelineExpectedProducts(plan, version),
      /filename expansion/,
    );
});

test("materialization cannot make distinct declared asset names collide", () => {
  const request = input("binary");
  const product = request.contract.products[0];
  product.artifacts[0].filename = "Kungfu-{version}.tar.gz";
  product.artifacts.push({
    ...product.artifacts[0],
    id: "second",
    filename: "Kungfu-1.0.0.tar.gz",
  });
  product.targets[0].artifacts.push("second");
  request.route = request.contract.channels[2];
  assert.throws(
    () => planPipelinePublication(request),
    /filenames must be unique/,
  );
});

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
    fs.readFileSync(".buildchain/minimal-consumer.toml", "utf8"),
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
    fs.readFileSync(".buildchain/minimal-consumer.toml", "utf8"),
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
