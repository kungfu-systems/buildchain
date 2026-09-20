import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { initBuildchainRepo } from "../packages/core/adoption/commands/init-repo.mjs";
import { consumerAgentInstructions } from "../packages/core/adoption/consumer-init.js";
import { consumerWorkflows } from "../packages/core/consumer/contract/entries.js";
import { compileConsumerPlan } from "../packages/core/consumer/contract/plan.js";
import { inspectConsumerContract } from "../packages/core/consumer/contract/inspection.js";
import { validateConsumerWiring } from "../packages/core/consumer/contract/local-validation.js";
import { runDoctor } from "../packages/core/governance/cli/doctor.mjs";
import { selectExecutionRuntimeAction } from "../packages/core/runtime/entry/actions.js";
import { bindConsumerSource } from "../packages/core/consumer/contract/identity.js";
import {
  inspectPipelineSource,
  buildPipelineSource,
} from "../packages/core/workflow/pipeline/build.js";
const cli = path.resolve(import.meta.dirname, "../bin/buildchain.mjs");
function directory(t, npm = false) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-init-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  if (npm) {
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "example",
        version: "2.3.0-alpha.1",
        packageManager: "npm@11.8.0",
        scripts: { build: "node build.mjs", check: "node check.mjs" },
      }),
    );
    fs.writeFileSync(
      path.join(cwd, "build.mjs"),
      "console.log('build product');",
    );
    fs.writeFileSync(
      path.join(cwd, "check.mjs"),
      "console.log('check product');",
    );
  }
  return cwd;
}
for (const type of [
  "npm",
  "binary",
  "paper",
  "package",
  "native",
  "publication-artifact",
  "anchored-package",
])
  test(`init ${type} writes a schema-2 plan and the identical consumer pair`, (t) => {
    const cwd = directory(
      t,
      ["npm", "package", "anchored-package"].includes(type),
    );
    const result = initBuildchainRepo({
      cwd,
      type,
      packageManager: "npm",
      artifactName: "example",
    });
    assert.equal(result.schemaVersion, 2);
    const files = Object.fromEntries(
      fs
        .readdirSync(cwd, { recursive: true })
        .filter((file) => fs.statSync(path.join(cwd, file)).isFile())
        .map((file) => [
          file.split(path.sep).join("/"),
          fs.readFileSync(path.join(cwd, file), "utf8"),
        ]),
    );
    const plan = compileConsumerPlan(files[".buildchain/buildchain.toml"]);
    assert.equal(plan.products[0].type, result.productType);
    assert.equal(
      plan.version.strategy,
      type === "anchored-package" ? "anchored" : "semver",
    );
    for (const [file, bytes] of Object.entries(consumerWorkflows()))
      assert.equal(files[file], bytes);
    assert.deepEqual(
      validateConsumerWiring(
        cwd,
        ".buildchain/buildchain.toml",
      ).workflows.sort(),
      Object.keys(consumerWorkflows()).sort(),
    );
    const inspection = inspectConsumerContract(files);
    assert.equal(inspection.ok, true, inspection.issues.join("\n"));
    const validated = JSON.parse(
      execFileSync(
        process.execPath,
        [
          cli,
          "validate",
          "--cwd",
          cwd,
          "--require-version-state",
          "--require-lifecycle-stages",
          "build,verify",
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(validated.config.schema, 2);
    assert.equal(validated.products[0].type, result.productType);
    assert.equal(validated.consumer.channel, "v4");
    execFileSync("git", ["init", "-q", cwd]);
    const doctor = runDoctor({ cwd });
    assert.equal(doctor.ok, true, JSON.stringify(doctor.checks));
    assert.doesNotMatch(
      files["AGENTS.md"],
      /compare-and-swap|request\.json|next_development|packages\/core/,
    );
  });

test("a conflict in the last caller fails before any configuration is written", (t) => {
  const cwd = directory(t, true),
    file = path.join(cwd, ".github/workflows/buildchain-recover.yml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "owned by the user\n");
  assert.throws(() => initBuildchainRepo({ cwd }), /already exists/);
  assert.equal(
    fs.existsSync(path.join(cwd, ".buildchain/buildchain.toml")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(cwd, ".github/workflows/buildchain.yml")),
    false,
  );
  assert.equal(fs.readFileSync(file, "utf8"), "owned by the user\n");
});

test("force cannot turn unrelated or symlinked workflows into consumer wiring", (t) => {
  const cwd = directory(t, true),
    external = directory(t);
  fs.mkdirSync(path.join(cwd, ".github/workflows"), { recursive: true });
  const old = path.join(cwd, ".github/workflows/other.yml");
  fs.writeFileSync(old, "user workflow");
  assert.throws(
    () => initBuildchainRepo({ cwd, force: true }),
    /outside the generated consumer pair/,
  );
  fs.unlinkSync(old);
  fs.rmdirSync(path.join(cwd, ".github/workflows"));
  fs.writeFileSync(path.join(external, "buildchain.yml"), "external");
  fs.symlinkSync(external, path.join(cwd, ".github/workflows"), "junction");
  assert.throws(
    () => initBuildchainRepo({ cwd, force: true }),
    /regular files/,
  );
  assert.equal(
    fs.readFileSync(path.join(external, "buildchain.yml"), "utf8"),
    "external",
  );
  assert.equal(
    fs.existsSync(path.join(cwd, ".buildchain/buildchain.toml")),
    false,
  );
});

test("unsupported product types and invalid version authority leave no partial scaffold", (t) => {
  for (const type of ["web-surface", "infra-contract", "unknown"]) {
    const cwd = directory(t);
    assert.throws(() => initBuildchainRepo({ cwd, type }), /schema-2 pipeline/);
    assert.deepEqual(fs.readdirSync(cwd), []);
  }
  const cwd = directory(t);
  fs.writeFileSync(path.join(cwd, "release.json"), '{"version":false}');
  assert.throws(
    () => initBuildchainRepo({ cwd, type: "paper" }),
    /version must be a string/,
  );
  assert.equal(fs.existsSync(path.join(cwd, ".buildchain")), false);
});

test("managed instructions retire the old consumer controller and preserve user sections", () => {
  const source =
    "# User rules\n\n<!-- buildchain:next-development:v1:start -->\nrequest.json and compare-and-swap\n<!-- buildchain:next-development:v1:end -->\n\n## Product style\nKeep this.\n";
  const result = consumerAgentInstructions(source);
  assert.ok(result.startsWith("# User rules"));
  assert.ok(result.includes("## Product style\nKeep this."));
  assert.doesNotMatch(
    result,
    /request.json|compare-and-swap|next-development:v1/,
  );
  assert.equal(consumerAgentInstructions(result), result);
  assert.throws(
    () => consumerAgentInstructions("<!-- buildchain:consumer:start -->"),
    /Incomplete/,
  );
});

test("doctor rejects mutated caller bytes even when both filenames exist", (t) => {
  const cwd = directory(t, true);
  initBuildchainRepo({ cwd });
  execFileSync("git", ["init", "-q", cwd]);
  fs.appendFileSync(
    path.join(cwd, ".github/workflows/buildchain.yml"),
    "# consumer fork\n",
  );
  const result = runDoctor({ cwd });
  assert.equal(result.ok, false);
  assert.equal(
    result.checks.find((check) => check.id === "workflow.consumer-pair").status,
    "fail",
  );
});

for (const type of ["npm", "binary", "paper"])
  test(`initialized ${type} reaches runtime source admission without fabricated locks`, async (t) => {
    const cwd = directory(t, type === "npm");
    if (type === "npm") {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(cwd, "package.json")),
      );
      manifest.scripts = { build: "node build.cjs", check: "node check.cjs" };
      fs.writeFileSync(
        path.join(cwd, "package.json"),
        JSON.stringify(manifest),
      );
      fs.writeFileSync(
        path.join(cwd, "package-lock.json"),
        JSON.stringify({
          name: manifest.name,
          version: manifest.version,
          lockfileVersion: 3,
          requires: true,
          packages: { "": { name: manifest.name, version: manifest.version } },
        }),
      );
      fs.writeFileSync(
        path.join(cwd, "build.cjs"),
        "require('fs').writeFileSync('product.txt','built');\n",
      );
      fs.writeFileSync(
        path.join(cwd, "check.cjs"),
        "require('assert').equal(require('fs').readFileSync('product.txt','utf8'),'built');\n",
      );
    }
    initBuildchainRepo({ cwd, type, packageManager: "npm" });
    const git = (...args) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "initialized product",
    );
    const commit = git("rev-parse", "HEAD"),
      configPath = ".buildchain/buildchain.toml";
    const { identity: source } = bindConsumerSource(
      {
        repository: "example/consumer",
        commit,
        tree: git("rev-parse", "HEAD^{tree}"),
        configPath,
        configBlob: git("rev-parse", `HEAD:${configPath}`),
      },
      fs.readFileSync(path.join(cwd, configPath)),
    );
    const root = path.resolve(import.meta.dirname, "..");
    const runtimeSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const observed = [],
      outputs = {},
      inputs = {
        token: "fixture-read-only",
        "workflow-sha": runtimeSha,
        "workflow-ref":
          "kungfu-systems/buildchain/.github/workflows/public-ops-pipeline.yml@v4",
      };
    await selectExecutionRuntimeAction(
      {
        getInput: (name) => inputs[name] || "",
        setOutput: (name, value) => {
          outputs[name] = value;
        },
      },
      {
        GITHUB_REPOSITORY: source.repository,
        GITHUB_SHA: commit,
        GITHUB_REF: "refs/heads/feature/example",
        GITHUB_EVENT_NAME: "pull_request",
      },
      {
        githubFactory: () => ({
          rest: {
            repos: {
              getContent: async (request) => {
                observed.push(request);
                let content;
                if (`${request.owner}/${request.repo}` === source.repository) {
                  assert.equal(request.ref, commit);
                  assert.equal(request.path, ".buildchain/contract-lock.json");
                  try {
                    content = git("show", `${commit}:${request.path}`);
                  } catch {
                    throw Object.assign(
                      new Error("file absent at consumer source"),
                      { status: 404 },
                    );
                  }
                } else {
                  assert.equal(
                    `${request.owner}/${request.repo}`,
                    "kungfu-systems/buildchain",
                  );
                  assert.equal(request.ref, runtimeSha);
                  assert.equal(request.path, "architecture/runtime-entry.json");
                  content = execFileSync(
                    "git",
                    ["show", `${runtimeSha}:${request.path}`],
                    { cwd: root, encoding: "utf8" },
                  );
                }
                return {
                  data: {
                    type: "file",
                    encoding: "base64",
                    content: Buffer.from(content).toString("base64"),
                  },
                };
              },
            },
          },
        }),
      },
    );
    assert.equal(outputs.selection.origin, "workflow-default");
    assert.equal(outputs.selection.sha, runtimeSha);
    assert.equal(outputs.selection.source.sha, commit);
    assert.equal(observed.length, 2);
    assert.equal(inspectPipelineSource(cwd, source).products[0].type, type);
    if (type === "npm") {
      const built = await buildPipelineSource({
        cwd,
        source,
        platform: "linux-x64",
      });
      assert.equal(built.products[0].outcome, "success");
      assert.equal(
        fs.readFileSync(path.join(cwd, "product.txt"), "utf8"),
        "built",
      );
    }
    assert.equal(
      fs.existsSync(path.join(cwd, ".buildchain/contract-lock.json")),
      false,
    );
    assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
  });
