import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  command,
  requireValue,
  runOperation,
} from "../../runtime/action-process.mjs";

export function resetGateWorkspace(env) {
  const workspace = fs.realpathSync(env.GITHUB_WORKSPACE);
  const source = path.join(workspace, "source");
  const container = path.join(workspace, ".buildchain");
  const cache = path.join(container, "windows-gate-source-git");
  const sourceGit = path.join(source, ".git");
  for (const target of [source, container, cache, sourceGit]) {
    requireValue(
      !fs.existsSync(target) || !fs.lstatSync(target).isSymbolicLink(),
      "Gate source reset refuses symbolic links or directory junctions",
    );
  }
  if (fs.existsSync(sourceGit) && fs.statSync(sourceGit).isDirectory()) {
    fs.rmSync(cache, { recursive: true, force: true });
    fs.mkdirSync(container, { recursive: true });
    fs.renameSync(sourceGit, cache);
  }
  fs.rmSync(source, { recursive: true, force: true });
  if (fs.existsSync(cache) && fs.statSync(cache).isDirectory()) {
    fs.mkdirSync(source, { recursive: true });
    fs.renameSync(cache, sourceGit);
  }
}

export function windowsRustPlan(env) {
  requireValue(
    /^\d+$/.test(env.GITHUB_RUN_ID || "") &&
      /^\d+$/.test(env.GITHUB_RUN_ATTEMPT || ""),
    "Rust setup requires exact run coordinates",
  );
  requireValue(
    Boolean(env.RUNNER_TEMP) && !/[\r\n]/.test(env.RUNNER_TEMP),
    "Rust setup requires a bounded temporary directory",
  );
  requireValue(
    Boolean(env.BUILDCHAIN_RUST_TOOLCHAIN) &&
      !/[\r\n]/.test(env.BUILDCHAIN_RUST_TOOLCHAIN),
    "Rust toolchain is required",
  );
  const suffix = `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  const cargo = path.join(env.RUNNER_TEMP, `buildchain-gate-cargo-${suffix}`);
  const rustup = path.join(env.RUNNER_TEMP, `buildchain-gate-rustup-${suffix}`);
  const directory = path.join(
    env.RUNNER_TEMP,
    `buildchain-gate-rustup-init-${suffix}`,
  );
  const installer = path.join(directory, "rustup-init.exe");
  return {
    cargo,
    rustup,
    directory,
    installer,
    download: [
      "--proto",
      "=https",
      "--tlsv1.2",
      "--retry",
      "10",
      "--retry-connrefused",
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "https://win.rustup.rs/x86_64",
      "--output",
      installer,
    ],
    install: [
      "--default-toolchain",
      env.BUILDCHAIN_RUST_TOOLCHAIN,
      "--profile",
      "minimal",
      "-y",
      "--no-modify-path",
    ],
  };
}
export function setupWindowsRust(env, execute = command) {
  const plan = windowsRustPlan(env);
  fs.mkdirSync(plan.directory, { recursive: true });
  execute("curl.exe", plan.download);
  execute(plan.installer, plan.install, {
    env: { ...env, CARGO_HOME: plan.cargo, RUSTUP_HOME: plan.rustup },
  });
  fs.appendFileSync(env.GITHUB_PATH, `${path.join(plan.cargo, "bin")}\n`);
  fs.appendFileSync(
    env.GITHUB_ENV,
    `CARGO_HOME=${plan.cargo}\nRUSTUP_HOME=${plan.rustup}\n`,
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runOperation({
    reset: resetGateWorkspace,
    "windows-rust": setupWindowsRust,
  });
}
