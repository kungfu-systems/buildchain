import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { context, commonEnv, execute, main, script, sourceRoot, workspace } from "./context.mjs";

export async function prepareEnvironment() {
  const { plan, platform } = context();
  const checkout = plan.environment.checkout;
  await script("locked-source-checkout.mjs", { ...commonEnv(plan, platform),
    BUILDCHAIN_SOURCE_CHECKOUT_PATH: sourceRoot, BUILDCHAIN_CHECKOUT_HISTORY_MODE: checkout.history_mode,
    BUILDCHAIN_CHECKOUT_CACHE_MODE: checkout.mode, BUILDCHAIN_CHECKOUT_CACHE_MIRROR_URL_TEMPLATE: checkout.mirror_url_template,
    BUILDCHAIN_CHECKOUT_CACHE_REFERENCE_REPOSITORY_TEMPLATE: checkout.reference_repository_template,
    BUILDCHAIN_CHECKOUT_CACHE_FALLBACK: checkout.fallback, BUILDCHAIN_CHECKOUT_CACHE_TIMEOUT_SECONDS: checkout.timeout_seconds,
    BUILDCHAIN_CHECKOUT_CACHE_GITHUB_TIMEOUT_SECONDS: checkout.github_timeout_seconds,
    BUILDCHAIN_CHECKOUT_CACHE_FETCH_ATTEMPTS: checkout.fetch_attempts,
    BUILDCHAIN_SOURCE_CHECKOUT_DIAGNOSTICS_PATH: path.join(sourceRoot, ".buildchain/diagnostics/source-checkout.json") });
  if (!platform || process.env.BUILDCHAIN_PREPARE_TOOLS !== "true") return;
  const env = { ...commonEnv(plan, platform), BUILDCHAIN_CHECKOUT_CACHE_MODE: checkout.mode,
    BUILDCHAIN_EXPECTED_SOURCE_SHA: plan.source.sha, BUILDCHAIN_EXPECTED_SOURCE_REF: plan.source.ref };
  const evidenceRoot = `.buildchain/artifacts/${platform.id}`;
  if (platform.provider === "aws-codebuild") {
    await script("aws-runner-burst.mjs", { ...env, BUILDCHAIN_BURST_EVIDENCE_PATH: `${evidenceRoot}/aws-runner-burst.json`,
      BUILDCHAIN_BURST_PROVIDER: platform.provider, BUILDCHAIN_BURST_PROJECT: platform.project,
      BUILDCHAIN_BURST_SOURCE_REPOSITORY: plan.run.repository, BUILDCHAIN_BURST_SOURCE_SHA: plan.source.sha,
      BUILDCHAIN_BURST_SOURCE_REF: plan.source.ref, BUILDCHAIN_BURST_RUN_ID: plan.run.id, BUILDCHAIN_BURST_RUN_ATTEMPT: plan.run.attempt,
      BUILDCHAIN_BURST_JOB: process.env.GITHUB_JOB }, ["evidence"], { cwd: sourceRoot });
    await script("aws-codebuild-toolchain.mjs", { BUILDCHAIN_BURST_TOOLCHAIN_EVIDENCE_PATH: `${evidenceRoot}/aws-native-toolchain.json` }, ["prepare"], { cwd: sourceRoot });
  }
  for (const [provider, name, prefix] of [["aws-ec2-windows-jit", "aws-windows-jit", "WINDOWS"], ["aws-ec2-macos-jit", "aws-macos-jit", "MACOS"]]) {
    if (platform.provider === provider) await script(`${name}.mjs`, { ...env, [`BUILDCHAIN_${prefix}_JIT_EVIDENCE_PATH`]: `${evidenceRoot}/${name}.json` }, ["evidence"], { cwd: sourceRoot });
  }
  if (process.env.GITHUB_PATH) for (const directory of [path.join(os.homedir(), ".local/bin"), path.join(os.homedir(), ".cargo/bin")]) fs.appendFileSync(process.env.GITHUB_PATH, `${directory}\n`);
}

// A single implementation handles the fresh, per-job Windows Rust installation.
export async function prepareWindowsRust() {
  const { plan } = context();
  if (process.platform !== "win32" || !plan.tools.setup_rust) throw new Error("Windows Rust setup is not applicable");
  const temporary = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "buildchain-rust-"));
  const installer = path.join(temporary, "rustup-init.exe");
  const env = { CARGO_HOME: path.join(temporary, "cargo"), RUSTUP_HOME: path.join(temporary, "rustup"),
    RUSTUP_DIST_SERVER: plan.environment.tools.rustup_dist_server || "https://static.rust-lang.org",
    RUSTUP_UPDATE_ROOT: plan.environment.tools.rustup_update_root || "https://static.rust-lang.org/rustup" };
  await execute("curl.exe", ["--proto", "=https", "--tlsv1.2", "--retry", "10", "--retry-connrefused", "--fail", "--silent", "--show-error", "--location", "https://win.rustup.rs/x86_64", "--output", installer]);
  await execute(installer, ["--default-toolchain", plan.tools.rust, "--profile", "minimal", "-y", "--no-modify-path"], { env });
  fs.appendFileSync(process.env.GITHUB_PATH, `${path.join(env.CARGO_HOME, "bin")}\n`);
  fs.appendFileSync(process.env.GITHUB_ENV, `CARGO_HOME=${env.CARGO_HOME}\nRUSTUP_HOME=${env.RUSTUP_HOME}\n`);
}
main(import.meta.url, () => process.argv[2] === "windows-rust" ? prepareWindowsRust() : prepareEnvironment());
