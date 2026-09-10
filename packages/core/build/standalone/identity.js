import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
export function platformTriple() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (platform === "win32") {
    return "x86_64-pc-windows-msvc";
  }
  if (platform === "linux") {
    return arch === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : "x86_64-unknown-linux-gnu";
  }
  return `${arch}-${platform}`;
}

export function copyNodeBinary(destination, nodePath) {
  fs.copyFileSync(nodePath, destination);
  if (process.platform !== "win32") {
    fs.chmodSync(destination, 0o755);
  }
}

export function packageVersion(cwd) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(cwd, "package.json"), "utf8"),
  );
  return packageJson.version;
}

export function sourceSha(cwd) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  const value = String(result.stdout || "").trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(
      "standalone binary requires an exact Buildchain source SHA",
    );
  }
  return value;
}
