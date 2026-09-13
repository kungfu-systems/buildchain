import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyStageCapsuleCheckpoints } from "../packages/core/build/stage-capsule/rehearsal/verify.js";

const platform = {
  linux: "linux-x64",
  darwin: "macos-arm64",
  win32: "windows-x64",
}[process.platform];
if (!platform)
  throw new Error(
    `Unsupported product verification platform: ${process.platform}`,
  );
const goVersion = execFileSync("go", ["version"], { encoding: "utf8" }).trim();
const goMatch = /^go version go1\.(\d+)\./u.exec(goVersion);
if (!goMatch || Number(goMatch[1]) < 25)
  throw new Error(
    `Product verification requires Go 1.25 or newer in major 1: ${goVersion}`,
  );
const workspace = process.cwd();
const result = verifyStageCapsuleCheckpoints({
  runtimeRoot: workspace,
  workspace,
  platform,
  environment: process.env,
});
if (platform === "linux-x64") {
  // Same immutable image and backbone tests as the retired container CI lane.
  // Supply the selected Node as the hosted container runner did; no credentials.
  const image =
    "ghcr.io/kungfu-systems/build-images/kungfu-verify@sha256:11f0ba64267ce88174a4f73a9bf833ff4e9c59cd16ec3d08a6432a06c2be6fb1";
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--network=none",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--mount",
      `type=bind,source=${path.resolve(workspace)},target=/source,readonly`,
      "--mount",
      `type=bind,source=${process.execPath},target=/toolchain/node,readonly`,
      "--env",
      "PATH=/toolchain:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "--workdir",
      "/source",
      image,
      "node",
      "--test",
      "tests/build-orchestration.test.mjs",
      "tests/build-artifact-pipeline.test.mjs",
      "tests/dev-delivery-minimal-request.test.mjs",
    ],
    { stdio: "inherit" },
  );
}
console.log(
  JSON.stringify({
    platform,
    checkpoint: result.checkpoint,
    resume: result.resume,
    tail: result.tail,
  }),
);
