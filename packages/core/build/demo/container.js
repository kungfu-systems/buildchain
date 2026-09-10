import fs from "node:fs";
import path from "node:path";
import { command, requireValue } from "../../runtime/action-process.mjs";
const layouts = {
  smoke: {
    input: "gate-work/smoke-input",
    output: "gate-work/smoke-render",
    memory: "512m",
  },
  render: { input: "gate-bundle", output: "render-work", memory: "1g" },
  "inspect-smoke": {
    input: "gate-work/smoke-render",
    output: "gate-work/smoke-inspection",
    memory: "128m",
  },
  "inspect-render": {
    input: "render-work",
    output: "render-inspection",
    memory: "128m",
  },
};

export function demoContainerArguments(
  request,
  operation,
  exists = fs.existsSync,
) {
  requireValue(
    Object.hasOwn(layouts, operation),
    "Unknown demo container operation",
  );
  requireValue(
    /^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$/u.test(
      request.rendererImage || "",
    ),
    "renderer-image must be an immutable image@sha256:digest coordinate",
  );
  const layout = layouts[operation];
  const workspace = path.resolve(request.workspace);
  const volume = (source, target) => [
    "--volume",
    `${path.join(workspace, source)}:${target}`,
  ];
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,size=${layout.memory}`,
  ];
  if (operation.startsWith("inspect-"))
    return [
      ...args,
      "--volume",
      `${request.runtimeRoot}:/buildchain:ro`,
      ...volume(layout.input, "/media:ro"),
      ...volume(layout.output, "/inspection"),
      "--entrypoint",
      "node",
      request.rendererImage,
      "/buildchain/packages/core/build/demo/inspection-worker.js",
      JSON.stringify({
        renderOutput: "/media",
        rendererImage: request.rendererImage,
        output: "/inspection/media-inspection.json",
      }),
    ];
  const capture = [];
  if (operation === "render") {
    if (exists(path.join(workspace, layout.input, "rendition-set.json"))) {
      capture.push(
        "--terminal-capture",
        "/input/terminal-capture.json",
        "--rendition-set",
        "/input/rendition-set.json",
      );
    } else if (
      exists(path.join(workspace, layout.input, "terminal-capture.json"))
    ) {
      capture.push("--terminal-capture", "/input/terminal-capture.json");
    }
  }
  return [
    ...args,
    ...volume(layout.input, "/input:ro"),
    ...volume(layout.output, "/output"),
    request.rendererImage,
    "demo-renderer",
    "--scene",
    "/input/scene.json",
    "--transcript",
    "/input/complete-transcript.txt",
    "--projection",
    "/input/public-projection.json",
    ...capture,
    "--output",
    "/output",
    "--renderer-image",
    request.rendererImage,
  ];
}

export function runDemoContainer(request, operation, execute = command) {
  const args = demoContainerArguments(request, operation);
  const output = path.join(request.workspace, layouts[operation].output);
  if (!operation.startsWith("inspect-"))
    execute("docker", ["pull", request.rendererImage]);
  fs.mkdirSync(output, { recursive: true });
  fs.chmodSync(output, 0o777);
  execute("docker", args);
}
