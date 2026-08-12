import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "tsup";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("bundled action runtime resolves KFD adopter profile assets from the installed package", async (t) => {
  const runtimeRoot = fs.mkdtempSync(
    path.join(root, ".buildchain/kfd-action-bundle-"),
  );
  const entryPath = path.join(runtimeRoot, "entry.mjs");
  const outputDir = path.join(
    runtimeRoot,
    "actions/promote-buildchain-ref/dist",
  );
  const witnessDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-kfd-action-witness-"),
  );
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true }));
  t.after(() => fs.rmSync(witnessDir, { recursive: true }));
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    entryPath,
    [
      `import { generateBuildchainKfdAdopterRelease } from ${JSON.stringify(path.join(root, "scripts/generate-buildchain-kfd-witnesses.mjs"))};`,
      "const generated = await generateBuildchainKfdAdopterRelease({",
      `  cwd: ${JSON.stringify(root)},`,
      `  outputDir: ${JSON.stringify(witnessDir)},`,
      `  sourceSha: ${JSON.stringify("a".repeat(40))},`,
      `  checkedAt: ${JSON.stringify("2026-08-11T00:00:00.000Z")},`,
      "  emitOutputs: false,",
      "});",
      "console.log(JSON.stringify(generated));",
      "",
    ].join("\n"),
  );

  await build({
    entry: [entryPath],
    format: ["esm"],
    target: "node24",
    platform: "node",
    splitting: false,
    sourcemap: false,
    minify: true,
    clean: false,
    outDir: outputDir,
    noExternal: [/.*/],
    banner: {
      js: "import { createRequire as __buildchainCreateRequire } from 'node:module';\nconst require = __buildchainCreateRequire(import.meta.url);",
    },
  });

  const bundlePath = path.join(outputDir, "entry.js");
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "await import(process.env.BUILDCHAIN_KFD_ACTION_BUNDLE);",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          BUILDCHAIN_KFD_ACTION_BUNDLE: pathToFileURL(bundlePath).href,
        },
      },
    ),
  );
  assert.equal(result.status, "passed");
  assert.match(
    result.outputs["kfd-adopter-manifest-root"],
    /^sha256:[0-9a-f]{64}$/,
  );
  assert.match(
    result.outputs["kfd-adopter-gate-root"],
    /^sha256:[0-9a-f]{64}$/,
  );
});

test("consumer promotion action starts without an installed KFD package tree", () => {
  const runtimeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-consumer-action-"),
  );
  try {
    const bundlePath = path.join(runtimeRoot, "index.js");
    fs.copyFileSync(
      path.join(root, "actions/promote-buildchain-ref/dist/index.js"),
      bundlePath,
    );
    const result = spawnSync(process.execPath, [bundlePath], {
      cwd: runtimeRoot,
      encoding: "utf8",
      env: {
        GITHUB_ACTION: "portability-test",
        GITHUB_REPOSITORY: "example/consumer",
        GITHUB_WORKSPACE: runtimeRoot,
        PATH: process.env.PATH,
      },
    });
    assert.doesNotMatch(
      `${result.stdout || ""}\n${result.stderr || ""}`,
      /Cannot find module '@kungfu-tech\/kfd\/package\.json'/u,
    );
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
