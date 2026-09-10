import { qualifyMediaFixture } from "./renderer-evidence.js";
import fs from "node:fs";
import path from "node:path";
import { command, requireValue } from "../../runtime/action-process.mjs";

const directory = ".buildchain/media-profile";
function outputDirectory(request, name) {
  const output = path.join(request.workspace, directory, name);
  fs.mkdirSync(output, { recursive: true });
  fs.chmodSync(output, 0o777);
}
export function mediaContainerArguments(request, operation) {
  requireValue(
    ["render", "inspect"].includes(operation),
    "Unknown media container operation",
  );
  requireValue(
    /^ghcr\.io\/kungfu-systems\/build-images\/demo-renderer@sha256:[0-9a-f]{64}$/u.test(
      request.rendererImage || "",
    ),
    "Media qualification requires an immutable renderer image",
  );
  const workspace = path.resolve(request.workspace);
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
      /^[a-z0-9-]+$/u.test(request.fixture || ""),
      "Media fixture must be a registered directory name",
    );
    args.push(
      ...volume(`contracts/fixtures/${request.fixture}`, "/input:ro"),
      ...volume(`${directory}/render`, "/output"),
      request.rendererImage,
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
      request.rendererImage,
    );
  } else
    args.push(
      ...volume("", "/buildchain:ro"),
      ...volume(`${directory}/render`, "/media:ro"),
      ...volume(`${directory}/inspection`, "/inspection"),
      "--entrypoint",
      "node",
      request.rendererImage,
      "/buildchain/packages/core/build/demo/inspection-worker.js",
      JSON.stringify({
        renderOutput: "/media",
        rendererImage: request.rendererImage,
        output: "/inspection/media-inspection.json",
      }),
    );
  return args;
}

export function verifyMediaBaseline(request) {
  requireValue(
    /^[a-z0-9-]+\.json$/u.test(request.evidence || ""),
    "Media baseline must be a registered evidence file",
  );
  const baseline = path.join(
    request.workspace,
    "contracts/evidence",
    request.evidence,
  );
  if (fs.existsSync(baseline)) {
    const measured = path.join(request.workspace, directory, "evidence.json");
    requireValue(
      fs.readFileSync(baseline).equals(fs.readFileSync(measured)),
      "Measured media evidence differs from the checked-in baseline",
    );
  }
}
export async function qualifyMediaProfile(request, ports = {}) {
  const execute = ports.execute || command;
  const renderArgs = mediaContainerArguments(request, "render");
  outputDirectory(request, "render");
  await execute("docker", renderArgs);
  outputDirectory(request, "inspection");
  await execute("docker", mediaContainerArguments(request, "inspect"));
  const evidence = await (ports.measure || qualifyMediaFixture)({
    renderOutput: path.join(request.workspace, directory, "render"),
    output: path.join(request.workspace, directory, "evidence.json"),
    mediaInspection: path.join(
      request.workspace,
      directory,
      "inspection/media-inspection.json",
    ),
    mediaProfile: request.profile,
    rendererImage: request.rendererImage,
    rendererSourceRepository: request.rendererSourceRepository,
    rendererSourceRef: request.rendererSourceRef,
    rendererSourceSha: request.rendererSourceSha,
  });
  await (ports.baseline || verifyMediaBaseline)(request);
  return evidence;
}
