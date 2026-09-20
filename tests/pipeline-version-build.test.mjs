import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bindConsumerSource } from "../packages/core/consumer/contract/identity.js";
import { planPipelineVersionPreparation } from "../packages/core/publication/pipeline/version-preparation.js";
import { buildPipelineVersionMaterial } from "../packages/core/publication/pipeline/version-build.js";

function fixture(t, extra = "") {
  const cwd = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pipeline-version-build-"),
  );
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, ".buildchain"));
  fs.mkdirSync(path.join(cwd, "src"));
  fs.mkdirSync(path.join(cwd, "dist"));
  fs.cpSync(
    new URL("../templates/minimal-consumer/npm/.github", import.meta.url),
    path.join(cwd, ".github"),
    { recursive: true },
  );
  const configPath = ".buildchain/buildchain.toml";
  const config = fs
    .readFileSync(
      new URL(
        "../templates/minimal-consumer/npm/.buildchain/buildchain.toml",
        import.meta.url,
      ),
      "utf8",
    )
    .replace("[version]\n", '[version]\nderived_files = ["dist/facts.json"]\n');
  fs.writeFileSync(path.join(cwd, configPath), config);
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    '{"version":"1.0.0-alpha.1","scripts":{"test":"node src/verify.mjs"}}\n',
  );
  fs.writeFileSync(
    path.join(cwd, "dist/facts.json"),
    '{"version":"1.0.0-alpha.1"}\n',
  );
  fs.writeFileSync(
    path.join(cwd, "src/build.mjs"),
    `import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
fs.writeFileSync('dist/facts.json', JSON.stringify({version: pkg.version})+'\\n');
`,
  );
  fs.writeFileSync(
    path.join(cwd, "src/verify.mjs"),
    `import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
assert.equal(JSON.parse(fs.readFileSync('dist/facts.json','utf8')).version, '1.0.0-alpha.2');
assert.equal(process.env.GITHUB_TOKEN, undefined);
assert.equal(process.env.NODE_AUTH_TOKEN, undefined);
fs.writeFileSync(process.env.GITHUB_OUTPUT, 'qualified=true');
${extra}
`,
  );
  const git = (...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Buildchain Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  const { identity: source, plan: contract } = bindConsumerSource(
    {
      repository: "example/product",
      commit: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD^{tree}"),
      configPath,
      configBlob: git("rev-parse", `HEAD:${configPath}`),
    },
    Buffer.from(config),
  );
  const runtime = {
    repository: "kungfu-systems/buildchain",
    sha: "a".repeat(40),
    readerDigest: `sha256:${"b".repeat(64)}`,
  };
  const preparation = planPipelineVersionPreparation({
    source,
    contract,
    runtime,
    attempt: `attempt-${"c".repeat(64)}`,
    generation: `sha256:${"d".repeat(64)}`,
    parentRoot: `sha256:${"e".repeat(64)}`,
    purpose: "development",
    version: "1.0.0-alpha.2",
  });
  return {
    cwd,
    git,
    preparation,
    platform: "linux-x64",
    environment: {
      ...process.env,
      BUILDCHAIN_RUNTIME_SHA: runtime.sha,
      GITHUB_TOKEN: "test-secret",
      NODE_AUTH_TOKEN: "test-secret",
      GITHUB_OUTPUT: path.join(cwd, "authority-output"),
    },
  };
}

test("real credentialless product commands regenerate only declared version material", async (t) => {
  const request = fixture(t);
  const result = await buildPipelineVersionMaterial(request);
  assert.equal(result.preparationRoot, request.preparation.root);
  assert.equal(
    JSON.parse(result.files["dist/facts.json"]).version,
    "1.0.0-alpha.2",
  );
  assert.equal(fs.existsSync(request.environment.GITHUB_OUTPUT), false);
  assert.equal(
    request.git("rev-parse", "HEAD"),
    request.preparation.source.commit,
  );
});

test("version preparation rejects runtime drift before source mutation and retains failed product exits", async (t) => {
  const wrong = fixture(t);
  await assert.rejects(
    buildPipelineVersionMaterial({
      ...wrong,
      environment: {
        ...wrong.environment,
        BUILDCHAIN_RUNTIME_SHA: "f".repeat(40),
      },
    }),
    /admitted execution runtime/,
  );
  assert.equal(wrong.git("status", "--porcelain"), "");
  const failed = fixture(t, "process.exit(7);");
  await assert.rejects(
    buildPipelineVersionMaterial(failed),
    (error) => error.status === 7,
  );
});

test("source byte guards reject index-hidden edits and a product-created replacement HEAD", async (t) => {
  const hidden = fixture(
    t,
    "execFileSync('git', ['update-index', '--assume-unchanged', 'src/build.mjs']); fs.appendFileSync('src/build.mjs', '// hidden edit');",
  );
  await assert.rejects(
    buildPipelineVersionMaterial(hidden),
    /undeclared source bytes/,
  );
  const replaced = fixture(
    t,
    "execFileSync('git', ['add', '.']); execFileSync('git', ['-c', 'user.name=Buildchain Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'replacement']);",
  );
  await assert.rejects(
    buildPipelineVersionMaterial(replaced),
    /admitted Git HEAD or tree/,
  );
  const command = fixture(
    t,
    "const pkg=JSON.parse(fs.readFileSync('package.json','utf8')); pkg.scripts.test='node publish.mjs'; fs.writeFileSync('package.json', JSON.stringify(pkg,null,2)+'\\n');",
  );
  await assert.rejects(
    buildPipelineVersionMaterial(command),
    /outside the planned version fields/,
  );
});
