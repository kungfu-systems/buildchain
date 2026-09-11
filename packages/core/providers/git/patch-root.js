import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";

// Hash exact Git patch bytes with bounded memory, including large action assets.
export function gitPatchRoot({ cwd, base, head, mergeBase = false }) {
  for (const revision of [base, head])
    if (!/^[0-9a-f]{40}$/u.test(revision || ""))
      throw new Error("Git patch roots require exact commit SHAs");
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-git-patch-"),
  );
  let descriptor;
  try {
    descriptor = fs.openSync(path.join(directory, "patch"), "w+", 0o600);
    const result = spawnSync(
      "git",
      [
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        `${base}${mergeBase ? "..." : ".."}${head}`,
      ],
      {
        cwd,
        stdio: ["ignore", descriptor, "pipe"],
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
    );
    if (result.error || result.status !== 0)
      throw new Error(
        `Git patch read failed: ${result.error?.message || result.stderr || result.signal || result.status}`,
      );
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0,
      bytes;
    while (
      (bytes = fs.readSync(descriptor, buffer, 0, buffer.length, position)) > 0
    ) {
      hash.update(buffer.subarray(0, bytes));
      position += bytes;
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
