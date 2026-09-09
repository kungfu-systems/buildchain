import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  command,
  requireValue,
  runOperation,
} from "../../runtime/action-process.mjs";

const directory = ".buildchain/media-profile";
function outputDirectory(name) {
  const output = `${directory}/${name}`;
  fs.mkdirSync(output, { recursive: true });
  fs.chmodSync(output, 0o777);
}
export function mediaContainerArguments(env, operation) {
  requireValue(
    ["render", "inspect"].includes(operation),
    "Unknown media container operation",
  );
  requireValue(
    /^ghcr\.io\/kungfu-systems\/build-images\/demo-renderer@sha256:[0-9a-f]{64}$/u.test(
      env.RENDERER_IMAGE || "",
    ),
    "Media qualification requires an immutable renderer image",
  );
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  const volume = (source, destination) => [
    "--volume",
    `${path.join(workspace, source)}:${destination}`,
  ];
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,size=${operation === "render" ? "512" : "128"}m`,
  ];
  if (operation === "render") {
    requireValue(
      /^[a-z0-9-]+$/u.test(env.MEDIA_FIXTURE || ""),
      "Media fixture must be a registered directory name",
    );
    args.push(
      ...volume(`contracts/fixtures/${env.MEDIA_FIXTURE}`, "/input:ro"),
      ...volume(`${directory}/render`, "/output"),
      env.RENDERER_IMAGE,
      "demo-renderer",
      "--scene",
      "/input/scene.json",
      "--transcript",
      "/input/complete-transcript.txt",
      "--projection",
      "/input/public-projection.json",
      "--output",
      "/output",
      "--renderer-image",
      env.RENDERER_IMAGE,
    );
  } else
    args.push(
      ...volume("", "/buildchain:ro"),
      ...volume(`${directory}/render`, "/media:ro"),
      ...volume(`${directory}/inspection`, "/inspection"),
      "--entrypoint",
      "node",
      env.RENDERER_IMAGE,
      "/buildchain/packages/core/build/commands/auditable-demo.mjs",
      "inspect-media",
      "--render-output",
      "/media",
      "--renderer-image",
      env.RENDERER_IMAGE,
      "--output",
      "/inspection/media-inspection.json",
    );
  return args;
}
export function measureMedia(env) {
  command(process.execPath, [
    "packages/core/build/commands/auditable-demo.mjs",
    "qualify-media-fixture",
    "--render-output",
    `${directory}/render`,
    "--media-inspection",
    `${directory}/inspection/media-inspection.json`,
    "--media-profile",
    env.MEDIA_PROFILE,
    "--renderer-image",
    env.RENDERER_IMAGE,
    "--renderer-source-repository",
    env.RENDERER_SOURCE_REPOSITORY,
    "--renderer-source-ref",
    env.RENDERER_SOURCE_REF,
    "--renderer-source-sha",
    env.RENDERER_SOURCE_SHA,
    "--output",
    `${directory}/evidence.json`,
  ]);
  const result = JSON.parse(
    fs.readFileSync(`${directory}/evidence.json`, "utf8"),
  );
  console.log(
    JSON.stringify(
      result.qualification.renditions.map(
        ({ path, role, root, bytes, maximumBytes }) => ({
          path,
          role,
          root,
          bytes,
          maximumBytes,
        }),
      ),
      null,
      2,
    ),
  );
}
export function verifyMediaBaseline(env) {
  requireValue(
    /^[a-z0-9-]+\.json$/u.test(env.EVIDENCE_FILE || ""),
    "Media baseline must be a registered evidence file",
  );
  const baseline = `contracts/evidence/${env.EVIDENCE_FILE}`;
  if (fs.existsSync(baseline))
    command("diff", ["-u", baseline, `${directory}/evidence.json`]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runOperation({
    render: (env) => {
      const args = mediaContainerArguments(env, "render");
      outputDirectory("render");
      command("docker", args);
    },
    inspect: (env) => {
      const args = mediaContainerArguments(env, "inspect");
      outputDirectory("inspection");
      command("docker", args);
    },
    measure: measureMedia,
    baseline: verifyMediaBaseline,
  });
