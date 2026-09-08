import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadBuildchainConfig } from "../packages/core/buildchain-config.js";
import { containedBuildPath, discoverBuildConfiguration, normalizeBuildConfiguration } from "../packages/core/build-configuration.js";
import { writeGitHubOutputs } from "./github-output.mjs";

const runtimeRoot = path.resolve(import.meta.dirname, "..");
const digest = (value) => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
const rootOf = (value) => digest(JSON.stringify(value));

export function resolveBuildConfiguration({ root, locator = "", workflowRef, workflowSha, repository, sourceSha, sourceRef, callerWorkflowRef = "", eventName = "", baseRef = "", environmentRegistry = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "architecture/build-environments.json"), "utf8")) }) {
  for (const [label, value] of Object.entries({ workflowSha, sourceSha })) {
    if (!/^[a-f0-9]{40}$/u.test(value || "")) throw new Error(`${label} must be an exact SHA`);
  }
  const match = String(workflowRef).match(/^([^/]+\/[^/]+)\/(\.github\/workflows\/[^@]+)@(?:refs\/(?:heads|tags)\/)?(v([1-9]\d*)(-alpha)?)$/u);
  if (!match || match[1] !== repository) throw new Error("Ordinary builds require the exact called workflow identity on a floating channel");
  const identity = {
    repository, ref: match[3], full_ref: `refs/tags/${match[3]}`,
    sha: workflowSha, channel: match[5] ? "alpha" : "stable", major: match[4],
    visible_workflow: match[2],
  };
  const callerPath = callerWorkflowRef.split("@")[0].split("/.github/workflows/")[1];
  if (callerPath) {
    const caller = fs.readFileSync(containedBuildPath(root, `.github/workflows/${callerPath}`), "utf8");
    const calls = [...caller.matchAll(/uses:\s+kungfu-systems\/buildchain\/(\.github\/workflows\/(?:build|\.build|public-build-candidate|\.build-engine)\.yml)@(v\d+(?:-alpha)?)\s*$/gmu)]
      .filter((call) => call[2] === identity.ref);
    const paths = [...new Set(calls.map((call) => call[1]))];
    if (paths.length !== 1) throw new Error("Unable to derive one visible build workflow from the exact caller");
    identity.visible_workflow = paths[0];
  }
  const project = discoverBuildConfiguration(root, locator);
  const loaded = loadBuildchainConfig(path.resolve(root, project.cwd));
  const build = normalizeBuildConfiguration(loaded.config.build);
  if (environmentRegistry.schema !== "buildchain.build-environments/v1" || !Object.hasOwn(environmentRegistry.profiles, build.environment)) {
    throw new Error(`Unknown governed build environment: ${build.environment}`);
  }
  const overrides = environmentRegistry.profiles[build.environment];
  const environment = Object.fromEntries(Object.entries(environmentRegistry.defaults).map(([group, values]) => [group, { ...values, ...overrides[group] }]));
  const projectPath = (relative) => {
    containedBuildPath(path.resolve(root, project.cwd), relative);
    const selected = path.posix.join(project.cwd, relative);
    containedBuildPath(root, selected);
    return selected;
  };
  const evidence = (relative) => relative ? JSON.stringify(JSON.parse(fs.readFileSync(containedBuildPath(root, projectPath(relative)), "utf8"))) : "";
  const dependencyFiles = ["pnpm-lock.yaml", "package-lock.json", "Cargo.lock", "go.sum"].map(projectPath).filter((file) => fs.existsSync(path.join(root, file)));
  const plan = {
    schema: "buildchain.build-plan/v1", project,
    configuration_root: digest(fs.readFileSync(loaded.filePath)),
    identity,
    source: {
      sha: sourceSha, ref: sourceRef,
      candidate_channel: /^(?:refs\/heads\/)?release\//u.test(baseRef || sourceRef) ? "release"
        : /^(?:refs\/heads\/)?(?:alpha|dev)\//u.test(baseRef || sourceRef) ? "alpha"
          : eventName === "workflow_dispatch" ? (identity.channel === "stable" ? "release" : "alpha") : "none",
    },
    environment, environment_root: rootOf(environment),
    build,
    lifecycle: Object.fromEntries(["install", "build", "verify"].map((stage) => [stage, { required: stage === "build" || Boolean(loaded.config.lifecycle?.[stage]), configured: Boolean(loaded.config.lifecycle?.[stage]) }])),
    tools: { node: build.tools.node, setup_node: Boolean(build.tools.node), rust: build.tools.rust || "stable", setup_rust: Boolean(build.tools.rust), go: build.tools.go, setup_go: Boolean(build.tools.go) },
    artifacts: {
      name: build.artifacts.name,
      paths: build.artifacts.paths.map(projectPath).join("\n"),
      expected_json: JSON.stringify({
        minFiles: build.artifacts.min_files, maxFiles: build.artifacts.max_files,
        minTotalBytes: build.artifacts.min_total_bytes,
        requiredPaths: build.artifacts.required_paths.map(projectPath),
      }),
    },
    evidence: { gate_profile_json: evidence(build.evidence.gate_profile_path), candidate_family_json: evidence(build.evidence.candidate_family_path) },
    cache: {
      dependency_root: rootOf(dependencyFiles.map((file) => [file, digest(fs.readFileSync(path.join(root, file)))])),
      toolchain_root: rootOf({ tools: build.tools, environment: environment.tools }),
      policy_root: rootOf(environment.cache),
    },
    contract: { lock_path: identity.channel === "alpha" ? ".buildchain/alpha-contract-lock.json" : ".buildchain/contract-lock.json" },
  };
  for (const [stage, status] of Object.entries(plan.lifecycle)) {
    if (status.required && !status.configured) throw new Error(`buildchain.toml must declare lifecycle.${stage}`);
  }
  return { plan, root: rootOf(plan) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const resolved = resolveBuildConfiguration({
      root: process.env.BUILDCHAIN_CONSUMER_ROOT,
      locator: process.env.BUILDCHAIN_CONFIG_PATH,
      workflowRef: process.env.BUILDCHAIN_WORKFLOW_REF,
      workflowSha: process.env.BUILDCHAIN_WORKFLOW_SHA,
      repository: process.env.BUILDCHAIN_WORKFLOW_REPOSITORY,
      sourceSha: process.env.GITHUB_SHA,
      sourceRef: process.env.GITHUB_REF,
      callerWorkflowRef: process.env.GITHUB_WORKFLOW_REF,
      eventName: process.env.GITHUB_EVENT_NAME,
      baseRef: process.env.GITHUB_BASE_REF,
    });
    writeGitHubOutputs({ "plan-json": JSON.stringify(resolved.plan), "plan-root": resolved.root });
  } catch (error) {
    console.error(`::error::${String(error.message).replaceAll("\n", "%0A")}`);
    process.exitCode = 1;
  }
}
