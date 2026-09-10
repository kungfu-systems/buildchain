import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { devDeliveryContentRoot } from "../dev-delivery-warrant.js";
const SHA = /^[0-9a-f]{40}$/u;
export function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export function exactSha(value, label) {
  const normalized = required(value, label).toLowerCase();
  if (!SHA.test(normalized))
    throw new Error(`${label} must be an exact 40-hex Git SHA`);
  return normalized;
}

export function jsonList(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value || "[]");
  } catch (error) {
    throw new Error(`${label} must be a JSON array: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error(`${label} must be a non-empty JSON array`);
  return [
    ...new Set(
      parsed.map((entry) => String(entry || "").trim()).filter(Boolean),
    ),
  ].sort();
}

export function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(required(filePath, label), "utf8"));
  } catch (error) {
    throw new Error(`could not read ${label}: ${error.message}`);
  }
}

export function writeJson(filePath, value) {
  const target = path.resolve(required(filePath, "output"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

export function git(args, { cwd = process.cwd(), encoding = "utf8" } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${String(result.stderr || "").trim()}`,
    );
  return encoding === null ? result.stdout : String(result.stdout || "").trim();
}

export function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

export function fileFact(filePath, workspace) {
  const absolute = path.resolve(filePath);
  return {
    path: path
      .relative(path.resolve(workspace), absolute)
      .split(path.sep)
      .join("/"),
    size: fs.statSync(absolute).size,
    sha256: sha256(fs.readFileSync(absolute)),
  };
}

export function gitPathRoot(ref, paths, label, cwd) {
  const files = paths.map((filePath) => {
    const normalized = filePath.replace(/^\.\//u, "");
    if (!normalized || normalized.includes("\n"))
      throw new Error(`${label} contains an invalid path`);
    return {
      path: normalized,
      blob: exactSha(
        git(["rev-parse", `${ref}:${normalized}`], { cwd }),
        `${label} blob for ${normalized}`,
      ),
    };
  });
  return devDeliveryContentRoot({
    schema: "kungfu.buildchain.git-path-set/v1",
    label,
    files,
  });
}
