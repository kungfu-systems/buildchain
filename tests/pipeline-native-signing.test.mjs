import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parse, stringify } from "smol-toml";
import { compileConsumerPlan } from "../packages/core/consumer/contract/plan.js";
import {
  planPipelinePublication,
  verifyPipelinePublicationPlan,
} from "../packages/core/publication/pipeline/plan.js";
import { qualifyPipelineProducts } from "../packages/core/publication/pipeline/qualification.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

function config() {
  const value = parse(
    fs.readFileSync(
      "templates/minimal-consumer/binary/.buildchain/buildchain.toml",
      "utf8",
    ),
  );
  const product = value.products[0];
  product.id = "kungfu";
  product.platforms = ["macos-arm64"];
  product.artifacts = [
    { id: "cli", path: "release/cli.tar.gz", kind: "archive" },
    { id: "desktop", path: "release/desktop.zip", kind: "archive" },
    { id: "installer", path: "release/desktop.dmg", kind: "installer" },
  ];
  product.targets[0].artifacts = ["cli", "desktop", "installer"];
  product.signing = [
    {
      artifact: "cli",
      profile: "apple-developer-id",
      kind: "archive",
      entitlements_profile: "jit-executable-v1",
      entitlements_paths: ["runtime/kungfu"],
    },
    {
      artifact: "desktop",
      profile: "apple-developer-id",
      kind: "app-bundle",
      path: "dist/Kungfu.app",
      bundle_id: "io.kungfu.app",
      installer: "installer",
    },
  ];
  product.finalize = ["node scripts/verify-signed-product.mjs"];
  return value;
}
const compile = (value) => compileConsumerPlan(stringify(value));
function publication(contract) {
  return planPipelinePublication({
    attempt: `attempt-${"a".repeat(64)}`,
    generation: `generation-${"b".repeat(64)}`,
    source: {
      repository: "example/product",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
    },
    runtime: { sha: "c".repeat(40) },
    publisher: { sha: "c".repeat(40) },
    contract,
    route: contract.channels[1],
    version: "1.0.0-alpha.1",
    sourceTimestamp: "2026-09-19T00:00:00Z",
  });
}

test("product signatures bind required native intent to exact source publication outputs", () => {
  const contract = compile(config());
  const plan = publication(contract);
  assert.deepEqual(
    plan.nativeSigning.map((rule) => rule.id),
    ["kungfu-macos-arm64-cli", "kungfu-macos-arm64-desktop"],
  );
  assert.equal(plan.nativeSigning[0].entitlements_profile, "jit-executable-v1");
  assert.equal(plan.nativeSigning[1].installer, "installer");
  verifyPipelinePublicationPlan(plan);
  assert.equal(plan.schema, "buildchain.pipeline-publication-plan/v2");
  const { root, ...downgrade } = plan;
  downgrade.schema = "buildchain.pipeline-publication-plan/v1";
  downgrade.evidenceVersion = 1;
  assert.throws(
    () =>
      verifyPipelinePublicationPlan({
        ...downgrade,
        root: recordDigest(downgrade),
      }),
    /retained root/,
  );
  const changed = structuredClone(plan);
  changed.nativeSigning[0].entitlements_paths = ["different/executable"];
  assert.throws(() => verifyPipelinePublicationPlan(changed), /retained root/);
  assert.throws(
    () => qualifyPipelineProducts({ plan }),
    /independently admitted signing and finalization/,
  );
});

test("native declarations reject credentials, unsigned fallback, mismatched formats and multiple writers", () => {
  const mutations = [
    (p) => {
      p.signing[0].certificate = "not-a-credential";
    },
    (p) => {
      p.signing[0].required = false;
    },
    (p) => {
      p.signing[0].profile = "detached-signature-v1";
    },
    (p) => {
      p.signing[0].artifact = "missing";
    },
    (p) => {
      p.signing[0].entitlements_paths = ["runtime/*"];
    },
    (p) => {
      p.signing[0].entitlements_profile = "";
    },
    (p) => {
      p.artifacts[0].path = "release/cli.tar.xz";
    },
    (p) => {
      p.signing[1].path = "dist/*.app";
    },
    (p) => {
      p.signing[1].path = "../Kungfu.app";
    },
    (p) => {
      p.signing[1].bundle_id = "io.kungfu.app\n";
    },
    (p) => {
      p.signing[1].installer = "desktop";
    },
    (p) => {
      p.signing[1].entitlements_profile = "none";
    },
    (p) => {
      p.signing.push(structuredClone(p.signing[0]));
    },
    (p) => {
      p.signing = [];
    },
    (p) => {
      delete p.signing;
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const value = config();
    mutate(value.products[0]);
    assert.throws(
      () => compile(value),
      undefined,
      `invalid signing declaration ${index}`,
    );
  }
  const value = config();
  value.products[0].platforms = ["linux-x64"];
  value.products[0].artifacts[2].path = "release/desktop.AppImage";
  assert.throws(
    () => compile(value),
    /Apple signing requires a macOS binary product/,
  );
});

test("unsigned contracts keep their original publication plan shape", () => {
  const value = config();
  delete value.products[0].signing;
  delete value.products[0].finalize;
  assert.equal(
    Object.hasOwn(publication(compile(value)), "nativeSigning"),
    false,
  );
});
