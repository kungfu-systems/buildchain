import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function run(command, args, options = {}) {
  const completed = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (completed.error) throw completed.error;
  return completed;
}

export function expectPass(result, label) {
  if (result.status !== 0)
    throw new Error(
      `${label} failed with ${result.status}: ${(result.stderr || "").trim()}`,
    );
}

export function resolveInput(consumerRoot, value) {
  return path.isAbsolute(value) ? value : path.join(consumerRoot, value);
}

export function collectReports(root) {
  const reports = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        const candidate = readJson(target);
        if (
          candidate?.contract ===
          "kungfu-buildchain-v4-cross-platform-adopter-report/v1"
        )
          reports.push(candidate);
      }
    }
  };
  visit(root);
  return reports;
}
