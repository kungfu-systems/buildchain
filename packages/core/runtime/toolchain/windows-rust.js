import fs from "node:fs";
import path from "node:path";
import { command } from "../action-process.mjs";
export function prepareWindowsRust(
  {
    toolchain,
    runnerTemp,
    distServer,
    updateRoot,
    environment,
    platform = process.platform,
  },
  execute = command,
) {
  if (platform !== "win32")
    throw new Error("Windows Rust setup is not applicable");
  if (!String(toolchain || "").trim())
    throw new Error("An exact Rust toolchain declaration is required");
  const temporary = fs.mkdtempSync(path.join(runnerTemp, "buildchain-rust-"));
  const installer = path.join(temporary, "rustup-init.exe");
  const variables = {
    CARGO_HOME: path.join(temporary, "cargo"),
    RUSTUP_HOME: path.join(temporary, "rustup"),
    RUSTUP_DIST_SERVER: distServer || "https://static.rust-lang.org",
    RUSTUP_UPDATE_ROOT: updateRoot || "https://static.rust-lang.org/rustup",
  };
  const env = { ...environment, ...variables };
  execute(
    "curl.exe",
    [
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
    { env },
  );
  execute(
    installer,
    [
      "--default-toolchain",
      toolchain,
      "--profile",
      "minimal",
      "-y",
      "--no-modify-path",
    ],
    { env },
  );
  // The toolchain lives until the job ends; deleting it here would invalidate later lifecycle stages.
  return {
    variables: {
      CARGO_HOME: variables.CARGO_HOME,
      RUSTUP_HOME: variables.RUSTUP_HOME,
    },
    paths: [path.join(variables.CARGO_HOME, "bin")],
  };
}
