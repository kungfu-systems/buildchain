import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse, stringify } from "smol-toml";
import { compileConsumerPlan } from "../packages/core/consumer/contract/plan.js";
import {
  inspectPipelineFileArtifact,
  packPipelineProducts,
} from "../packages/core/publication/pipeline/pack.js";
import { verifyPipelineProductFiles } from "../packages/core/publication/pipeline/files.js";
import { pipelineExpectedProducts } from "../packages/core/publication/pipeline/plan.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

function header(suffix) {
  const bytes = Buffer.alloc(1024);
  if (suffix === ".dmg") {
    bytes.write("koly", 512);
    bytes.writeUInt32BE(4, 516);
    bytes.writeUInt32BE(512, 520);
  } else if (suffix === ".exe") {
    bytes.write("MZ");
    bytes.writeUInt32LE(128, 60);
    bytes.writeUInt32LE(0x4550, 128);
    bytes.writeUInt16LE(0x20b, 152);
  } else {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 2]).copy(
      bytes,
    );
  }
  return bytes;
}

test("Windows installer download names preserve spaces without admitting unsafe paths", (t) => {
  const config = parse(
    fs.readFileSync(
      "templates/minimal-consumer/binary/.buildchain/buildchain.toml",
      "utf8",
    ),
  );
  const product = config.products[0];
  product.platforms = ["windows-x64"];
  product.artifacts[0] = {
    id: "main",
    path: "dist/installer.exe",
    kind: "installer",
    filename: "Kungfu Setup {version}.exe",
  };
  const compiled = compileConsumerPlan(stringify(config));
  const outputs = pipelineExpectedProducts(compiled, "4.0.0-alpha.5");
  assert.equal(outputs[0].filename, "Kungfu Setup 4.0.0-alpha.5.exe");
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pipeline-windows-name-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist/installer.exe"), header(".exe"));
  const body = {
    schema: "buildchain.pipeline-publication-plan/v1",
    version: "4.0.0-alpha.5",
    outputs,
  };
  const output = path.join(root, "packed");
  const manifest = packPipelineProducts({
    cwd: root,
    output,
    plan: { ...body, root: recordDigest(body) },
    platform: "windows-x64",
    source: {
      repository: "example/product",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
    },
  });
  assert.equal(
    manifest.artifacts[0].file,
    "payloads/Kungfu Setup 4.0.0-alpha.5.exe",
  );
  verifyPipelineProductFiles(output, manifest);
  for (const filename of [
    " Kungfu.exe",
    "Kungfu.exe ",
    "Kungfu/Setup.exe",
    "Kungfu\\Setup.exe",
    "Kungfu\nSetup.exe",
    "Kungfu;Setup.exe",
  ]) {
    product.artifacts[0].filename = filename;
    assert.throws(
      () => compileConsumerPlan(stringify(config)),
      /filename.*invalid string/,
    );
  }
});

for (const [suffix, platform] of [
  [".dmg", "macos-arm64"],
  [".exe", "windows-x64"],
  [".AppImage", "linux-x64"],
]) {
  test(`native ${suffix} declaration preserves format and platform`, () => {
    const config = parse(
      fs.readFileSync(
        "templates/minimal-consumer/binary/.buildchain/buildchain.toml",
        "utf8",
      ),
    );
    const product = config.products[0];
    product.platforms = [platform];
    product.artifacts[0] = {
      id: "main",
      path: `dist/installer${suffix}`,
      kind: "installer",
      filename: `Product${suffix}`,
    };
    const plan = compileConsumerPlan(stringify(config));
    assert.equal(
      pipelineExpectedProducts(plan)[0].filename,
      `Product${suffix}`,
    );
    product.platforms = [
      platform === "linux-x64" ? "windows-x64" : "linux-x64",
    ];
    assert.throws(
      () => compileConsumerPlan(stringify(config)),
      /installer format does not match/,
    );
    product.platforms = [platform];
    product.artifacts[0].filename = "Product.zip";
    assert.throws(
      () => compileConsumerPlan(stringify(config)),
      /extension does not match/,
    );
  });

  test(`native ${suffix} format inspection is read-only and rejects malformed bytes`, (t) => {
    const root = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "pipeline-installer-"),
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, `Product${suffix}`);
    const bytes = header(suffix);
    fs.writeFileSync(file, bytes);
    const expected = { path: path.basename(file), kind: "installer" };
    const before = fs.statSync(file);
    assert.deepEqual(inspectPipelineFileArtifact(root, expected), {
      file,
      suffix,
    });
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
    assert.deepEqual(fs.readdirSync(root), [path.basename(file)]);
    const body = {
      schema: "buildchain.pipeline-publication-plan/v1",
      version: "1.0.0",
      outputs: [
        {
          id: `desktop/${platform}/installer`,
          product: "desktop",
          artifact: "installer",
          directory: ".",
          platform,
          path: path.basename(file),
          kind: "installer",
          filename: path.basename(file),
          targets: [{ provider: "github-release" }],
        },
      ],
    };
    const plan = { ...body, root: recordDigest(body) };
    const output = path.join(root, "packed");
    const manifest = packPipelineProducts({
      cwd: root,
      output,
      plan,
      platform,
      source: {
        repository: "example/product",
        commit: "a".repeat(40),
        tree: "b".repeat(40),
      },
    });
    assert.equal(manifest.artifacts[0].kind, "installer");
    assert.equal(manifest.artifacts[0].file, `payloads/Product${suffix}`);
    assert.deepEqual(
      fs.readFileSync(path.join(output, manifest.artifacts[0].file)),
      bytes,
    );
    verifyPipelineProductFiles(output, manifest);
    const namedBody = {
      ...body,
      outputs: pipelineExpectedProducts(
        {
          products: [
            {
              id: "desktop",
              platforms: [platform],
              artifacts: [
                {
                  id: "installer",
                  path: path.basename(file),
                  kind: "installer",
                  filename: `Product-{version}-{platform}${suffix}`,
                },
              ],
              targets: [
                { provider: "github-release", artifacts: ["installer"] },
              ],
            },
          ],
        },
        "1.0.0",
      ),
    };
    const namedOutput = path.join(root, "versioned");
    const named = packPipelineProducts({
      cwd: root,
      output: namedOutput,
      plan: { ...namedBody, root: recordDigest(namedBody) },
      platform,
      source: manifest.source,
    });
    assert.equal(
      named.artifacts[0].file,
      `payloads/Product-1.0.0-${platform}${suffix}`,
    );
    assert.deepEqual(
      fs.readFileSync(path.join(namedOutput, named.artifacts[0].file)),
      bytes,
    );
    verifyPipelineProductFiles(namedOutput, named);
    fs.appendFileSync(
      path.join(output, manifest.artifacts[0].file),
      "tampered",
    );
    assert.throws(
      () => verifyPipelineProductFiles(output, manifest),
      /differ|match|changed/,
    );
    fs.writeFileSync(file, Buffer.alloc(1024));
    assert.throws(
      () => inspectPipelineFileArtifact(root, expected),
      /requires/,
    );
    fs.writeFileSync(file, bytes.subarray(0, 20));
    assert.throws(
      () => inspectPipelineFileArtifact(root, expected),
      /truncated/,
    );
  });
}

test("an EXE cannot point outside its file or masquerade as an archive", (t) => {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pipeline-installer-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "setup.exe");
  const bytes = header(".exe");
  bytes.writeUInt32LE(0xffffffff, 60);
  fs.writeFileSync(file, bytes);
  assert.throws(
    () =>
      inspectPipelineFileArtifact(root, {
        path: "setup.exe",
        kind: "installer",
      }),
    /truncated/,
  );
  assert.throws(
    () =>
      inspectPipelineFileArtifact(root, { path: "setup.exe", kind: "archive" }),
    /standard archive/,
  );
});
