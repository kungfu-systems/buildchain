import { npmPublishTransaction } from "../../../publication/npm/transaction.js";
import { npmPublicationEnvironment } from "../../../publication/npm/environment.js";
import {
  getLifecycleStage,
  runLifecycleStage,
} from "../../../consumer/buildchain-config.js";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { execNpmSync } from "./npm-distribution.js";
import {
  discoverVersionStateFiles,
  updateVersionStateContents,
} from "../../version-state.js";
import { publishTransactionEnvironment } from "./transaction-context.js";
export function runPublishCommand({ cwd, command, provider, loadedConfig, env }) {
  if (provider) {
    if (provider.kind !== "npm" || !provider.directory || command) throw new Error("Invalid or ambiguous declarative publication provider");
    npmPublishTransaction({ cwd: path.resolve(cwd, provider.directory), publication: npmPublicationEnvironment(env), env: { ...process.env, ...env } });
    return "provider:npm";
  }
  const lifecyclePublish = getLifecycleStage(loadedConfig, "publish");
  if (command) {
    execSync(command, {
      cwd,
      env: { ...process.env, ...env },
      stdio: "inherit",
      shell: true,
    });
    return "workflow-input";
  }
  if (lifecyclePublish) {
    runLifecycleStage({
      cwd,
      loadedConfig,
      name: "publish",
      stage: lifecyclePublish,
      env,
    });
    return "buildchain.toml";
  }
  return "none";
}
export function rematerializedNpmPackEnvironment({
  cwd,
  env,
  version,
  published = false,
}) {
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) return undefined;
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const required = JSON.parse(env.BUILDCHAIN_REQUIRED_ARTIFACTS || "[]");
  const requiredNpm = required.filter((artifact) => artifact.kind === "npm");
  if (requiredNpm.length === 0) return undefined;
  if (!requiredNpm.some((artifact) => artifact.name === pkg.name)) {
    throw new Error(
      `rematerialized npm package does not match required artifacts: ${pkg.name}`,
    );
  }
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-rematerialized-npm-"),
  );
  try {
    const packed = JSON.parse(
      execNpmSync(
        [
          "pack",
          ...(published ? [`${pkg.name}@${version}`] : []),
          "--json",
          "--pack-destination",
          temporaryRoot,
          "--registry=https://registry.npmjs.org/",
        ],
        {
          cwd,
          env: { ...process.env, ...env },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
        },
      ),
    );
    const result = Array.isArray(packed) ? packed[0] : packed;
    if (!result?.filename)
      throw new Error("rematerialized npm pack did not return a filename");
    if (result.name !== pkg.name || result.version !== version) {
      throw new Error(
        `rematerialized npm pack identity mismatch: expected ${pkg.name}@${version}, got ${result.name || ""}@${result.version || ""}`,
      );
    }
    const tarballPath = path.join(temporaryRoot, result.filename);
    const bytes = fs.readFileSync(tarballPath);
    return {
      temporaryRoot,
      env: {
        ...env,
        BUILDCHAIN_SEALED_BUNDLE_ROOT: "",
        BUILDCHAIN_SEALED_NPM_TARBALL: tarballPath,
        BUILDCHAIN_SEALED_NPM_INTEGRITY: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`,
        BUILDCHAIN_SEALED_NPM_SHA256: crypto
          .createHash("sha256")
          .update(bytes)
          .digest("hex"),
      },
    };
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
export function runRematerializedPublishCommand({
  cwd,
  command,
  loadedConfig,
  env,
  version,
  published = false,
}) {
  const discovered = discoverVersionStateFiles(cwd);
  const changedFiles = updateVersionStateContents(discovered.files, version);
  const originals = changedFiles.map((file) => {
    const resolved = path.resolve(cwd, file.path);
    return {
      resolved,
      content: fs.readFileSync(resolved),
    };
  });
  try {
    for (const [index, file] of changedFiles.entries()) {
      fs.writeFileSync(originals[index].resolved, file.content);
    }
    const npmPack = rematerializedNpmPackEnvironment({
      cwd,
      env,
      version,
      published,
    });
    const sealedEnvironmentNames = [
      "BUILDCHAIN_SEALED_BUNDLE_ROOT",
      "BUILDCHAIN_SEALED_NPM_TARBALL",
      "BUILDCHAIN_SEALED_NPM_INTEGRITY",
      "BUILDCHAIN_SEALED_NPM_SHA256",
    ];
    const previousSealedEnvironment = npmPack
      ? Object.fromEntries(
          sealedEnvironmentNames.map((name) => [name, process.env[name]]),
        )
      : undefined;
    try {
      if (npmPack) {
        Object.assign(
          process.env,
          Object.fromEntries(
            sealedEnvironmentNames.map((name) => [name, npmPack.env[name]]),
          ),
        );
      }
      return runPublishCommand({
        cwd,
        command,
        loadedConfig,
        env: npmPack?.env || env,
      });
    } finally {
      for (const [name, value] of Object.entries(
        previousSealedEnvironment || {},
      )) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      if (npmPack?.temporaryRoot)
        fs.rmSync(npmPack.temporaryRoot, { recursive: true, force: true });
    }
  } finally {
    for (const original of originals) {
      fs.writeFileSync(original.resolved, original.content);
    }
  }
}
export function runResumeRematerializedPublish({
  existingNpmPromotion,
  cwd,
  publishCommand,
  publishProvider,
  loadedConfig,
  context,
  version,
  published = false,
}) {
  if (existingNpmPromotion) {
    throw new Error(
      "publish-rematerialize-on-resume cannot replay promote-existing-version provider mutations",
    );
  }
  const source = runRematerializedPublishCommand({
    cwd,
    command: publishCommand,
    loadedConfig,
    env: publishTransactionEnvironment(context, { useSealedBundle: false }),
    version,
    published,
  });
  if (source === "none") {
    throw new Error(
      "publish-rematerialize-on-resume requires lifecycle.publish or publish-command",
    );
  }
  return `resume-rematerialized:${source}`;
}
