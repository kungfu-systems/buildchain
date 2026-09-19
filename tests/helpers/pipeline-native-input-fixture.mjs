import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse, stringify } from "smol-toml";
import { compileConsumerPlan } from "../../packages/core/consumer/contract/plan.js";
import { planPipelinePublication } from "../../packages/core/publication/pipeline/plan.js";
import { packPipelineProducts } from "../../packages/core/publication/pipeline/pack.js";
export function nativeInputFixture(t, app = false, configure = () => {}) {
  const cwd = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pipeline-native-input-"),
  );
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const config = parse(
    fs.readFileSync(
      "templates/minimal-consumer/binary/.buildchain/buildchain.toml",
      "utf8",
    ),
  );
  const p = config.products[0];
  p.platforms = ["macos-arm64"];
  fs.mkdirSync(path.join(cwd, "dist"));
  fs.writeFileSync(path.join(cwd, "payload"), "unsigned product bytes\n");
  execFileSync("tar", ["-czf", "dist/hello.tar.gz", "payload"], { cwd });
  p.signing = [
    { artifact: "main", profile: "apple-developer-id", kind: "archive" },
  ];
  if (app) {
    fs.mkdirSync(path.join(cwd, "dist/Kungfu.app/Contents"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(cwd, "dist/Kungfu.app/Contents/Info.plist"),
      "<plist><dict/></plist>",
    );
    execFileSync("/usr/bin/ditto", [
      "-c",
      "-k",
      "--keepParent",
      path.join(cwd, "dist/Kungfu.app"),
      path.join(cwd, "dist/desktop.zip"),
    ]);
    const dmg = Buffer.alloc(1024);
    dmg.write("koly", 512);
    dmg.writeUInt32BE(4, 516);
    dmg.writeUInt32BE(512, 520);
    fs.writeFileSync(path.join(cwd, "dist/desktop.dmg"), dmg);
    p.artifacts = [
      { id: "main", path: "dist/desktop.zip", kind: "archive" },
      { id: "installer", path: "dist/desktop.dmg", kind: "installer" },
    ];
    p.targets[0].artifacts = ["main", "installer"];
    p.signing = [
      {
        artifact: "main",
        profile: "apple-developer-id",
        kind: "app-bundle",
        path: "dist/Kungfu.app",
        bundle_id: "io.kungfu.app",
        installer: "installer",
      },
    ];
  }
  configure(p);
  const contract = compileConsumerPlan(stringify(config));
  const source = {
    repository: "example/product",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
  };
  const plan = planPipelinePublication({
    attempt: `attempt-${"a".repeat(64)}`,
    generation: `generation-${"b".repeat(64)}`,
    source,
    runtime: {
      repository: "kungfu-systems/buildchain",
      commit: "c".repeat(40),
      tree: "d".repeat(40),
    },
    publisher: { sha: "c".repeat(40) },
    contract,
    route: contract.channels[1],
    version: "1.0.0-alpha.1",
    sourceTimestamp: "2026-09-19T00:00:00Z",
  });
  const output = path.join(cwd, "output");
  const manifest = packPipelineProducts({
    cwd,
    output,
    plan,
    platform: "macos-arm64",
    source,
  });
  const requestRoot = path.join(output, "native-signing");
  const indexPath = path.join(requestRoot, "index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const requestPath = path.join(requestRoot, index.requests[0].path);
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  return {
    cwd,
    output,
    manifest,
    contract,
    plan,
    source,
    requestRoot,
    indexPath,
    index,
    requestPath,
    request,
  };
}
