import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  command,
  requireValue,
  runOperation,
} from "../../runtime/action-process.mjs";

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

export function demoContainerArguments(env, operation, exists = fs.existsSync) {
  requireValue(
    Object.hasOwn(layouts, operation),
    "Unknown demo container operation",
  );
  requireValue(
    /^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$/u.test(
      env.RENDERER_IMAGE || "",
    ),
    "renderer-image must be an immutable image@sha256:digest coordinate",
  );
  const layout = layouts[operation];
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
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
      ...volume(".buildchain/runtime", "/buildchain:ro"),
      ...volume(layout.input, "/media:ro"),
      ...volume(layout.output, "/inspection"),
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
    env.RENDERER_IMAGE,
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
    env.RENDERER_IMAGE,
  ];
}

export function runDemoContainer(env, operation, execute = command) {
  const args = demoContainerArguments(env, operation);
  const output = path.join(env.GITHUB_WORKSPACE, layouts[operation].output);
  if (!operation.startsWith("inspect-"))
    execute("docker", ["pull", env.RENDERER_IMAGE]);
  fs.mkdirSync(output, { recursive: true });
  fs.chmodSync(output, 0o777);
  execute("docker", args);
}

export function demoFinalizationArguments(
  env,
  operation,
  exists = fs.existsSync,
) {
  requireValue(
    ["finalize-gate", "finalize-media"].includes(operation),
    "Unknown demo finalization operation",
  );
  const file = (relative) => path.join(env.GITHUB_WORKSPACE, relative);
  const gate = operation === "finalize-gate";
  const inspection = file(
    gate
      ? "gate-work/smoke-inspection/media-inspection.json"
      : "render-inspection/media-inspection.json",
  );
  const args = gate
    ? [
        "--adapter-output",
        file("gate-work/adapter-output"),
        "--smoke-input",
        file("gate-work/smoke-input"),
        "--smoke-output",
        file("gate-work/smoke-render"),
        "--source-coordinate",
        file("gate-work/source-artifact.json"),
        "--diagnostics",
        file("gate-diagnostics"),
        "--adapter",
        env.ADAPTER_PATH,
      ]
    : [
        "--gate-bundle",
        file("gate-bundle"),
        "--gate-root",
        env.GATE_ROOT,
        "--render-output",
        file("render-work"),
      ];
  return [
    file(".buildchain/runtime/packages/core/build/commands/auditable-demo.mjs"),
    operation,
    ...args,
    "--renderer-image",
    env.RENDERER_IMAGE,
    "--source-sha",
    env.SOURCE_SHA,
    "--media-profile",
    env.MEDIA_PROFILE,
    ...(exists(inspection) ? ["--media-inspection", inspection] : []),
    "--output",
    file(gate ? "gate-bundle" : "media-bundle"),
    "--github-output",
    env.GITHUB_OUTPUT,
  ];
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runOperation({
    ...Object.fromEntries(
      Object.keys(layouts).map((operation) => [
        operation,
        (env) => runDemoContainer(env, operation),
      ]),
    ),
    ...Object.fromEntries(
      ["finalize-gate", "finalize-media"].map((operation) => [
        operation,
        (env) =>
          command(process.execPath, demoFinalizationArguments(env, operation)),
      ]),
    ),
  });
}
