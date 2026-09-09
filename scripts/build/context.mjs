import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { writeGitHubOutputs } from "../github-output.mjs";

export const runtimeRoot = path.resolve(import.meta.dirname, "../..");
export const workspace = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
export const sourceRoot = path.join(workspace, "source");
export const rootOf = (value) => `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
export function output(name, value) {
  writeGitHubOutputs({ [name]: typeof value === "object" ? JSON.stringify(value) : value });
}
export function assertPlan(plan) {
  const { root, ...body } = plan;
  if (plan.schema !== "buildchain.build-plan/v1" || root !== rootOf(body)) throw new Error("Build plan root mismatch");
  for (const sha of [plan.identity.sha, plan.source.sha, plan.source.tree_sha]) {
    if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("Build plan requires exact source, tree and runtime identities");
  }
  if (!Array.isArray(plan.platforms) || !plan.platforms.length || new Set(plan.platforms.map((p) => p.id)).size !== plan.platforms.length) {
    throw new Error("Build plan must declare unique platforms");
  }
  return plan;
}
export function context() {
  const plan = assertPlan(JSON.parse(process.env.BUILDCHAIN_PLAN));
  if (plan.run.id !== process.env.GITHUB_RUN_ID || plan.run.repository !== process.env.GITHUB_REPOSITORY || plan.run.attempt !== process.env.GITHUB_RUN_ATTEMPT) throw new Error("Build plan belongs to another run");
  const platformId = process.env.BUILDCHAIN_PLATFORM ? JSON.parse(process.env.BUILDCHAIN_PLATFORM).id : "";
  const platform = platformId ? plan.platforms.find((p) => p.id === platformId) : null;
  if (platformId && !platform) throw new Error("Platform is not in the build plan");
  return { plan, platform };
}
export function commonEnv(plan, platform) {
  return {
    BUILDCHAIN_SOURCE_REPOSITORY: plan.run.repository,
    BUILDCHAIN_SOURCE_SHA: plan.source.sha,
    BUILDCHAIN_SOURCE_TREE_SHA: plan.source.tree_sha,
    BUILDCHAIN_SOURCE_REF: plan.source.ref,
    BUILDCHAIN_RUNTIME_REPOSITORY: plan.identity.repository,
    BUILDCHAIN_RUNTIME_SHA: plan.identity.sha,
    BUILDCHAIN_RUNTIME_REF: plan.identity.ref,
    BUILDCHAIN_PLATFORM_ID: platform?.id || "",
    BUILDCHAIN_PLATFORM_NAME: platform?.name || "",
    BUILDCHAIN_ARTIFACT_NAME: plan.artifacts.name,
    BUILDCHAIN_DEPENDENCY_LOCK_ROOT: plan.cache.dependency_root,
    BUILDCHAIN_TOOLCHAIN_ROOT: plan.cache.toolchain_root,
    BUILDCHAIN_CACHE_POLICY_ROOT: plan.cache.policy_root,
  };
}
export function execute(command, args, { env = {}, cwd = workspace } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v ?? "")])) }, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} ${args[0] || ""} failed: ${signal || code}`)));
  });
}
export function parseOutputs(text) {
  const result = {};
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const multiline = line.match(/^([^=<]+)<<(.+)$/u);
    if (multiline) {
      const value = [];
      while (++index < lines.length && lines[index] !== multiline[2]) value.push(lines[index]);
      if (index === lines.length) throw new Error("Unterminated script output");
      result[multiline[1]] = value.join("\n");
    } else {
      const separator = line.indexOf("=");
      if (separator > 0) result[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
  return result;
}
// Existing domain CLIs keep their own policy. This adapter captures their
// structured output and preserves the real subprocess exit status.
export async function script(name, env = {}, args = [], options = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-output-"));
  const outputs = path.join(temporary, "outputs");
  fs.writeFileSync(outputs, "");
  try {
    await execute(process.execPath, [path.join(runtimeRoot, "scripts", name), ...args], { ...options, env: { ...env, GITHUB_OUTPUT: outputs } });
    return parseOutputs(fs.readFileSync(outputs, "utf8"));
  } catch (error) { error.outputs = parseOutputs(fs.readFileSync(outputs, "utf8")); throw error; }
  finally { fs.rmSync(temporary, { recursive: true }); }
}
export function main(url, fn) {
  if (process.argv[1] && url === pathToFileURL(path.resolve(process.argv[1])).href) {
    Promise.resolve().then(fn).catch((error) => {
      console.error(`::error::${String(error.message).replaceAll("\n", "%0A")}`);
      process.exitCode = 1;
    });
  }
}
