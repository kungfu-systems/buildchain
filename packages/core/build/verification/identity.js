import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
export const workflow = ".github/workflows/self-build-verify.yml";
export const hash = (bytes) =>
  `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
export function verificationCommand(
  program,
  args,
  workspace,
  env,
  encoding = "utf8",
) {
  return execFileSync(program, args, {
    cwd: workspace,
    env,
    encoding,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
export function verificationIdentity({
  env = process.env,
  workspace = process.cwd(),
  command = (program, args) =>
    verificationCommand(program, args, workspace, env).trim(),
  revision = "HEAD",
} = {}) {
  const sourceSha = command("git", ["rev-parse", revision]);
  const sourceTree = command("git", ["rev-parse", `${revision}^{tree}`]);
  const bytes = (file) =>
    verificationCommand(
      "git",
      ["show", `${sourceSha}:${file}`],
      workspace,
      env,
      null,
    );
  const named = (files) =>
    hash(JSON.stringify(files.map((file) => [file, hash(bytes(file))])));
  for (const key of ["GITHUB_REPOSITORY", "ImageOS", "ImageVersion"])
    if (!env[key]) throw new Error(`verification identity requires ${key}`);
  return {
    repository: env.GITHUB_REPOSITORY,
    sourceSha,
    sourceTree,
    workflowRoot: hash(bytes(workflow)),
    // Git tree records bind every descendant blob, including bundled actions and tests.
    checkDefinitionRoot: hash(
      verificationCommand(
        "git",
        [
          "ls-tree",
          "-r",
          "-z",
          sourceSha,
          "--",
          "actions",
          "packages/core",
          "scripts",
          "tests",
          "crates",
          "architecture",
          ".github/workflows",
          "package.json",
          ".buildchain/buildchain.toml",
        ],
        workspace,
        env,
        null,
      ),
    ),
    runtimeRoot: named([
      "packages/core/runtime/buildchain-domain.wasm",
      "packages/core/runtime/domain-wasm-artifact.js",
    ]),
    dependencyRoot: named([
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "crates/buildchain-domain-contracts/Cargo.lock",
      "crates/buildchain-host-bridge/Cargo.lock",
    ]),
    toolchainRoot: hash(
      JSON.stringify([
        command("node", ["--version"]),
        command("corepack", ["pnpm", "--version"]),
        command("go", ["version"]),
        command("rustc", ["+1.96.0", "--version"]),
        command("cargo", ["+1.96.0", "--version"]),
        command("rustc", ["--version"]),
        command("cargo", ["--version"]),
      ]),
    ),
    environmentRoot: hash(
      JSON.stringify([
        env.ImageOS,
        env.ImageVersion,
        process.platform,
        process.arch,
        ...[
          "CI",
          "NODE_ENV",
          "TZ",
          "LANG",
          "LC_ALL",
          "SOURCE_DATE_EPOCH",
          "BUILDCHAIN_SITE_GENERATED_AT",
          "BUILDCHAIN_SITE_PUBLISHED_AT",
          "BUILDCHAIN_SITE_TIMESTAMP_POLICY",
          "BUILDCHAIN_SOURCE_SHA",
          "RUSTUP_TOOLCHAIN",
          "RUSTFLAGS",
          "CARGO_ENCODED_RUSTFLAGS",
          "NODE_OPTIONS",
          "GOFLAGS",
          "GOTOOLCHAIN",
        ].map((key) => env[key] || ""),
      ]),
    ),
    platform:
      { linux: "linux", darwin: "macos", win32: "windows" }[process.platform] +
      `-${process.arch}`,
  };
}
