import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Only the exact current protected Dev commit may provide generator code.
export function prepareDevelopmentSource({ cwd, sourceSha }) {
  if (!/^[a-f0-9]{40}$/u.test(sourceSha || ""))
    throw new Error("development source requires an exact commit");
  execFileSync("git", ["fetch", "--no-tags", "origin", sourceSha], { cwd, stdio: "pipe" });
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-development-"),
  );
  const source = path.join(temporary, "source");
  const dispose = () => fs.rmSync(temporary, { recursive: true, force: true });
  try {
    // Version verification needs its own index and exact Git source identity.
    execFileSync(
      "git",
      ["clone", "--shared", "--no-checkout", path.resolve(cwd), source],
      { cwd, stdio: "pipe" },
    );
    // Shallow local clones omit commits reachable only through FETCH_HEAD.
    execFileSync("git", ["fetch", "--no-tags", path.resolve(cwd), sourceSha], { cwd: source, stdio: "pipe" });
    execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "checkout", "--detach", sourceSha], { cwd: source, stdio: "pipe" });
    const runtime = path.join(source, ".buildchain/runtime");
    fs.mkdirSync(runtime, { recursive: true });
    fs.symlinkSync(
      path.resolve(cwd, "node_modules"),
      path.join(runtime, "node_modules"),
      "junction",
    );
    fs.symlinkSync(path.join(runtime, "node_modules"), path.join(source, "node_modules"), "junction");
    return { cwd: source, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
