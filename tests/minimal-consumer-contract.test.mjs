import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { parse, stringify } from "smol-toml";
import { parse as yaml } from "yaml";
import {
  compileConsumerPlan,
  CONFIG_PATH,
} from "../packages/core/consumer/contract/plan.js";
import { standardConsumerExample } from "../packages/core/consumer/contract/examples.js";
import {
  consumerWorkflows,
  normalInputs,
  recoveryInputs,
  admitEvent,
} from "../packages/core/consumer/contract/entries.js";
import {
  bindConsumerSource,
  consumerContractLock,
} from "../packages/core/consumer/contract/identity.js";
import { inspectConsumerContract } from "../packages/core/consumer/contract/inspection.js";

const example = (type = "npm") => standardConsumerExample(type);
const config = () => parse(example()[CONFIG_PATH]);

test("ordinary task branches retain protected develop routes without admitting channel shortcuts", () => {
  for (const prefix of ["feature", "fix", "chore", "docs", "ci", "refactor"]) {
    const value = config();
    value.channels[0].from = `${prefix}/*`;
    assert.equal(
      compileConsumerPlan(stringify(value)).channels[0].operation,
      "develop",
    );
    value.channels[0].to = "alpha/v4/v4.1";
    value.channels[0].operation = "alpha";
    assert.throws(
      () => compileConsumerPlan(stringify(value)),
      /unlawful channel route/u,
    );
  }
});

test("self product migration retains full source qualification on each checkpoint platform", () => {
  const plan = compileConsumerPlan(
    fs.readFileSync(".buildchain/minimal-consumer.toml", "utf8"),
  );
  const declaration = JSON.parse(
    fs.readFileSync("architecture/platform-stage-checkpoints.json", "utf8"),
  );
  for (const { id } of declaration.platforms) {
    const products = plan.products.filter((product) =>
      product.platforms.includes(id),
    );
    assert.ok(products.length, `${id}: missing native product build`);
    const verified = products.find((product) =>
      product.verify.includes("corepack pnpm@11.7.0 run check"),
    );
    assert.ok(verified, `${id}: missing full source verification`);
    assert.ok(
      verified.build.includes("corepack pnpm@11.7.0 run build"),
      `${id}: missing candidate action build`,
    );
    assert.ok(
      verified.build.includes("corepack pnpm@11.7.0 run generate:site"),
      `${id}: missing candidate generated source build`,
    );
    assert.ok(
      verified.install.includes(
        "rustup component add --toolchain 1.96.0 rustfmt clippy",
      ),
      `${id}: missing Rust verification toolchain components`,
    );
  }
});

test("stable eligibility preserves required evidence without a self release delay", () => {
  const self = compileConsumerPlan(
    fs.readFileSync(".buildchain/minimal-consumer.toml", "utf8"),
  );
  const previous = JSON.parse(
    fs.readFileSync(".buildchain/stable-release-policy.json", "utf8"),
  );
  assert.deepEqual(self.stable, {
    minimum_interval_seconds: previous.minimumStableIntervalSeconds,
    minimum_soak_seconds: previous.minimumCanarySoakSeconds,
    product_paths: previous.productPathPrefixes,
    impact_file: ".buildchain/release-impact.json",
    require_published_entry: true,
  });
  assert.equal(self.stable.minimum_interval_seconds, 0);
  assert.equal(self.stable.minimum_soak_seconds, 0);
  assert.equal(compileConsumerPlan(example()[CONFIG_PATH]).stable, undefined);
  for (const change of [
    { minimum_soak_seconds: -1 },
    { minimum_interval_seconds: "3600" },
    { minimum_soak_seconds: 0.5 },
    { minimum_soak_seconds: Number.MAX_SAFE_INTEGER + 1 },
    { product_paths: ["../outside/"] },
    { product_paths: ["packages/*"] },
    { product_paths: ["packages/", "packages/"] },
    { product_paths: [123] },
    { impact_file: "../impact.json" },
    { impact_file: "impact*.json" },
    { require_published_entry: "false" },
    { enabled: false },
    { workflow: ".release-pipeline-products.yml" },
    { request_json: "{}" },
    { command: "npm publish" },
  ]) {
    const value = { ...config(), stable: { ...self.stable, ...change } };
    assert.throws(() => compileConsumerPlan(stringify(value)), /stable\./);
  }
});

test("npm root artifacts and stable download filenames remain product data with bounded paths", () => {
  const c = config();
  c.products[0].artifacts[0].path = ".";
  c.products[0].artifacts[0].filename = "product.tgz";
  assert.equal(
    compileConsumerPlan(stringify(c)).products[0].artifacts[0].path,
    ".",
  );
  for (const filename of [
    "../outside.tgz",
    "dir/product.tgz",
    "product.zip",
    ".hidden.tgz",
    `${"a".repeat(252)}.tgz`,
  ])
    assert.throws(
      () =>
        compileConsumerPlan(
          stringify({
            ...c,
            products: [
              {
                ...c.products[0],
                artifacts: [{ ...c.products[0].artifacts[0], filename }],
              },
            ],
          }),
        ),
      /filename/,
    );
  const binary = parse(example("binary")[CONFIG_PATH]);
  binary.products[0].artifacts[0].path = ".";
  assert.throws(() => compileConsumerPlan(stringify(binary)), /relative path/);
});

test("three products use byte-identical callers and closed publication plans", () => {
  const expected = consumerWorkflows();
  for (const type of ["npm", "binary", "paper"]) {
    const files = example(type),
      result = inspectConsumerContract(files);
    assert.deepEqual(result.issues, []);
    assert.equal(result.plan.products[0].type, type);
    for (const [file, bytes] of Object.entries(expected)) {
      assert.equal(files[file], bytes);
      const workflow = yaml(bytes);
      assert.deepEqual(Object.keys(workflow.jobs), ["buildchain"]);
      assert.equal(workflow.jobs.buildchain.steps, undefined);
    }
  }
});

test("only config location and exact attempt plus repaired runtime are consumer inputs", () => {
  assert.equal(normalInputs().configPath, CONFIG_PATH);
  assert.equal(
    normalInputs({ "config-path": "nested/buildchain.toml" }).configPath,
    "nested/buildchain.toml",
  );
  assert.throws(() => normalInputs({ "request-json": "{}" }), /unknown field/);
  assert.throws(
    () => normalInputs({ "runtime-ref": "v4-alpha" }),
    /unknown field/,
  );
  assert.throws(
    () => normalInputs({ "config-path": "../outside.toml" }),
    /relative path/,
  );
  assert.throws(() => recoveryInputs({ attempt: "3759" }), /invalid string/);
  assert.throws(
    () =>
      recoveryInputs({ attempt: `attempt-${"a".repeat(64)}`, "run-id": "42" }),
    /unknown field/,
  );
  assert.equal(
    recoveryInputs({
      attempt: `attempt-${"a".repeat(64)}`,
      "runtime-ref": "train/v4/v4.1/fix",
    }).runtimeRef,
    "train/v4/v4.1/fix",
  );
  assert.throws(() => admitEvent("workflow_dispatch"), /event.name/);
  assert.throws(() => admitEvent("pull_request", "arbitrary"), /event.action/);
  assert.equal(admitEvent("pull_request", "closed").action, "closed");
});

test("configuration cannot hide orchestration, weaken review or omit publication output", () => {
  const mutations = [
    (c) => {
      c.request_json = "{}";
    },
    (c) => {
      c.products[0].publish = ["npm publish"];
    },
    (c) => {
      c.products[0].targets[0].request = "{}";
    },
    (c) => {
      c.products[0].targets[0].artifacts = ["missing"];
    },
    (c) => {
      c.products[0].platforms.push("linux-x64");
    },
    (c) => {
      c.channels[0].operation = "stable";
    },
    (c) => {
      c.review.minimum_approvals = 0;
    },
    (c) => {
      c.review.merge_queue = false;
    },
    (c) => {
      c.version.command = "node custom-release.mjs";
    },
    (c) => {
      c.products[0].artifacts[0].path = "../secret";
    },
  ];
  for (const mutate of mutations) {
    const value = config();
    mutate(value);
    assert.throws(() => compileConsumerPlan(stringify(value)));
  }
});

test("compiler records commands as data and binds original bytes to the exact config blob", () => {
  const value = config();
  value.products[0].build = ["THIS MUST NEVER EXECUTE"];
  const bytes = stringify(value),
    blob = createHash("sha1")
      .update(`blob ${Buffer.byteLength(bytes)}\0`)
      .update(bytes)
      .digest("hex");
  const source = {
    repository: "example/product",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    configPath: CONFIG_PATH,
    configBlob: blob,
  };
  const result = bindConsumerSource(source, bytes);
  assert.equal(result.plan.products[0].build[0], "THIS MUST NEVER EXECUTE");
  assert.throws(() => bindConsumerSource(source, `${bytes}\n`), /do not match/);
  const lock = consumerContractLock({
    entry: { repository: "kungfu-systems/buildchain", sha: "c".repeat(40) },
    runtime: { repository: "kungfu-systems/buildchain", sha: "d".repeat(40) },
    configDigest: result.identity.configDigest,
  });
  assert.notEqual(lock.entry.sha, lock.runtime.sha);
  const laterSource = bindConsumerSource(
    { ...source, commit: "e".repeat(40) },
    bytes,
  );
  assert.notEqual(result.identityDigest, laterSource.identityDigest);
  assert.deepEqual(
    consumerContractLock({
      entry: lock.entry,
      runtime: lock.runtime,
      configDigest: laterSource.identity.configDigest,
    }),
    lock,
  );
  const changed = bindConsumerSource(
    {
      ...source,
      configBlob: createHash("sha1")
        .update(`blob ${Buffer.byteLength(bytes + "\n")}\0`)
        .update(bytes + "\n")
        .digest("hex"),
    },
    bytes + "\n",
  );
  assert.notEqual(changed.identity.configDigest, lock.configDigest);
});

test("full consumer tree inspection rejects scripts and extra workflow wiring", () => {
  for (const source of [
    "npm publish",
    "gh run download 42",
    "buildchain dev warrant settle",
    "const fencingToken = 1",
    "actions/download-artifact@v5",
    "request-json",
    'JSON.stringify({schema: "buildchain.dev-delivery-warrant/v1"})',
  ]) {
    const files = example();
    files["src/hidden.mjs"] = source;
    assert.equal(inspectConsumerContract(files).ok, false, source);
  }
  const files = example();
  files[".github/workflows/paper.yml"] = "jobs: {}";
  assert.match(
    inspectConsumerContract(files).issues.join("\n"),
    /extra consumer workflow/,
  );
  files[".github/workflows/buildchain.yml"] += "env:\n  STATE: '{}'\n";
  assert.match(inspectConsumerContract(files).issues.join("\n"), /thin caller/);
});

test("isolated examples execute only product build and verify and produce real product bytes", () => {
  // The native example declares linux-x64; other hosts still compile its contract.
  const types =
    process.platform === "linux"
      ? ["npm", "binary", "paper"]
      : ["npm", "paper"];
  for (const type of types) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `minimal-${type}-`));
    try {
      const files = example(type);
      for (const [file, bytes] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), bytes);
      }
      execFileSync(process.execPath, ["src/build.mjs"], { cwd: root });
      execFileSync(process.execPath, ["src/verify.mjs"], { cwd: root });
      if (type === "npm")
        assert.equal(
          JSON.parse(
            fs.readFileSync(path.join(root, "dist/package/package.json")),
          ).version,
          "1.0.0-alpha.1",
        );
      if (type === "binary")
        assert.equal(
          execFileSync(path.join(root, "dist/hello"), [], { encoding: "utf8" }),
          "hello\n",
        );
      if (type === "paper")
        assert.match(
          fs.readFileSync(path.join(root, "dist/paper.pdf"), "utf8"),
          /^%PDF-1\.4[\s\S]*%%EOF\n$/u,
        );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
