import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { bindConsumerSource } from "../packages/core/consumer/contract/identity.js";
import { buildPipelineSource } from "../packages/core/workflow/pipeline/build.js";

function checkout(t, verify) {
  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-pipeline-build-"),
  );
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.cpSync(
    new URL("../templates/minimal-consumer/npm/.buildchain", import.meta.url),
    path.join(cwd, ".buildchain"),
    { recursive: true },
  );
  fs.mkdirSync(path.join(cwd, "src"));
  fs.cpSync(
    new URL("../templates/minimal-consumer/npm/.github", import.meta.url),
    path.join(cwd, ".github"),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(cwd, "src/build.mjs"),
    "import fs from 'node:fs'; fs.writeFileSync('built.txt', 'built');\n",
  );
  fs.writeFileSync(path.join(cwd, "src/verify.mjs"), verify);
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
  const configPath = ".buildchain/buildchain.toml";
  const { identity: source } = bindConsumerSource(
    {
      repository: "example/consumer",
      commit: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD^{tree}"),
      configPath,
      configBlob: git("rev-parse", `HEAD:${configPath}`),
    },
    fs.readFileSync(path.join(cwd, configPath)),
  );
  return { cwd, source, platform: "linux-x64" };
}

test("generated product descendants receive no provider credential or authority output file", async (t) => {
  const descendant = `import assert from 'node:assert/strict';
import fs from 'node:fs';
assert.equal(fs.readFileSync('built.txt', 'utf8'), 'built');
for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'NODE_AUTH_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'BUILDCHAIN_WARRANT_RESULT'])
  assert.equal(process.env[key], undefined, key);
fs.writeFileSync(process.env.GITHUB_OUTPUT, 'qualified=true\\nrequest-json={"candidateRoot":"forged"}\\n');
`;
  const request = checkout(
    t,
    `import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
fs.writeFileSync('generated-product-test.mjs', ${JSON.stringify(descendant)});
execFileSync(process.execPath, ['generated-product-test.mjs'], {stdio:'inherit'});
`,
  );
  const output = path.join(request.cwd, "authority-output");
  const result = await buildPipelineSource({
    ...request,
    environment: {
      ...process.env,
      GITHUB_TOKEN: "test-secret",
      GH_TOKEN: "test-secret",
      ACTIONS_RUNTIME_TOKEN: "test-secret",
      NODE_AUTH_TOKEN: "test-secret",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-secret",
      BUILDCHAIN_WARRANT_RESULT: "test-authority",
      GITHUB_OUTPUT: output,
    },
  });
  assert.equal(result.products[0].outcome, "success");
  assert.equal(fs.existsSync(output), false);
});

test("product verification exit failure and tracked drift never produce success", async (t) => {
  const request = checkout(t, "process.exit(7);\n");
  await assert.rejects(
    buildPipelineSource(request),
    (error) => error.status === 7,
  );
  fs.writeFileSync(
    path.join(request.cwd, "src/verify.mjs"),
    "process.exit(0);\n",
  );
  await assert.rejects(buildPipelineSource(request), /tracked modifications/);
});

test("hidden publication commands are rejected before product execution", async (t) => {
  const request = checkout(
    t,
    "import { spawnSync as run } from 'node:child_process'; run('npm', ['publish']);\n",
  );
  await assert.rejects(buildPipelineSource(request), /internal-orchestration/u);
  assert.equal(fs.existsSync(path.join(request.cwd, "built.txt")), false);
});

test("a successful product command cannot change tracked source after admission", async (t) => {
  const request = checkout(
    t,
    "import fs from 'node:fs'; fs.appendFileSync('src/build.mjs', '// unexpected tracked mutation');\n",
  );
  await assert.rejects(buildPipelineSource(request), /tracked modifications/);
});

test("index-hidden source edits are rejected before any product command runs", async (t) => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const request = checkout(t, "process.exit(0);\n");
    execFileSync("git", ["update-index", flag, "src/build.mjs"], {
      cwd: request.cwd,
    });
    fs.appendFileSync(path.join(request.cwd, "src/build.mjs"), "// hidden\n");
    assert.equal(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: request.cwd,
        encoding: "utf8",
      }).trim(),
      "",
    );
    await assert.rejects(buildPipelineSource(request), /tracked source bytes/);
    assert.equal(fs.existsSync(path.join(request.cwd, "built.txt")), false);
  }
});

test("successful product commands cannot hide source drift with Git index flags", async (t) => {
  const request = checkout(
    t,
    `import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
execFileSync('git', ['update-index', '--assume-unchanged', 'src/build.mjs']);
fs.appendFileSync('src/build.mjs', '// hidden after build');
`,
  );
  await assert.rejects(buildPipelineSource(request), /tracked source bytes/);
  assert.equal(
    fs.readFileSync(path.join(request.cwd, "built.txt"), "utf8"),
    "built",
  );
});

test("tracked binary bytes are checked even when a local clean filter hides their replacement", async (t) => {
  const request = checkout(t, "process.exit(0);\n");
  const git = (...args) => execFileSync("git", args, { cwd: request.cwd });
  // The committed build program is changed on disk while a local filter makes
  // Git report its original content. Neither the index nor this filter is proof.
  const original = fs.readFileSync(path.join(request.cwd, "src/build.mjs"));
  fs.writeFileSync(path.join(request.cwd, "original.bin"), original);
  git("config", "filter.hide.clean", "cat original.bin");
  fs.writeFileSync(
    path.join(request.cwd, ".git/info/attributes"),
    "src/build.mjs filter=hide\n",
  );
  fs.writeFileSync(
    path.join(request.cwd, "src/build.mjs"),
    Buffer.from([0, 255, 13, 10]),
  );
  git("update-index", "--assume-unchanged", "src/build.mjs");
  assert.equal(git("diff", "HEAD", "--", "src/build.mjs").length, 0);
  await assert.rejects(buildPipelineSource(request), /tracked source bytes/);
  assert.equal(fs.existsSync(path.join(request.cwd, "built.txt")), false);
});

test(
  "source type, executable mode and parent links cannot be hidden from build qualification",
  {
    skip:
      process.platform === "win32" &&
      "POSIX modes and symlink creation require a native POSIX host",
  },
  async (t) => {
    for (const mutation of ["mode", "link", "parent"]) {
      const request = checkout(t, "process.exit(0);\n");
      const file = path.join(request.cwd, "src/build.mjs");
      execFileSync(
        "git",
        [
          "update-index",
          "--assume-unchanged",
          "src/build.mjs",
          "src/verify.mjs",
        ],
        {
          cwd: request.cwd,
        },
      );
      if (mutation === "mode") fs.chmodSync(file, 0o755);
      if (mutation === "link") {
        fs.renameSync(file, path.join(request.cwd, "original.mjs"));
        fs.symlinkSync("../original.mjs", file);
      }
      if (mutation === "parent") {
        fs.renameSync(
          path.join(request.cwd, "src"),
          path.join(request.cwd, "other"),
        );
        fs.symlinkSync("other", path.join(request.cwd, "src"));
      }
      await assert.rejects(
        buildPipelineSource(request),
        /source.*(?:mode|kind)|parent.*symbolic link|tracked modifications/,
      );
      assert.equal(fs.existsSync(path.join(request.cwd, "built.txt")), false);
    }
  },
);
