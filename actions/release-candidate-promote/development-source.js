import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Only the exact current protected Dev commit may provide generator code.
export function prepareDevelopmentSource({ cwd, sourceSha }) {
  if (!/^[a-f0-9]{40}$/u.test(sourceSha || ""))
    throw new Error("development source requires an exact commit");
  execFileSync("git", ["fetch", "--no-tags", "origin", sourceSha], {
    cwd,
    stdio: "pipe",
  });
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-development-"),
  );
  const source = path.join(temporary, "source");
  const dispose = () => fs.rmSync(temporary, { recursive: true, force: true });
  try {
    fs.mkdirSync(source);
    const archive = path.join(temporary, "source.tar");
    execFileSync(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "archive",
        "--format=tar",
        `--output=${archive}`,
        sourceSha,
      ],
      { cwd, stdio: "pipe" },
    );
    execFileSync("tar", ["-xf", "source.tar", "-C", "source"], { cwd: temporary, stdio: "pipe" });
    fs.symlinkSync(
      path.resolve(cwd, "node_modules"),
      path.join(source, "node_modules"),
      "junction",
    );
    return { cwd: source, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
