import { spawnSync } from "node:child_process";
import { sha256Text, stableJson } from "./json.js";
export function parseJsonCommandOutput({
  command = "",
  cwd = process.cwd(),
  label = "command",
} = {}) {
  const normalized = String(command || "").trim();
  if (!normalized) {
    return { value: undefined, path: "", sha256: "" };
  }
  const result = spawnSync(normalized, [], {
    cwd,
    shell: true,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    throw new Error(
      `${label} exited with ${result.status}${stderr ? `: ${stderr.slice(-1000)}` : ""}`,
    );
  }
  const stdout = String(result.stdout || "").trim();
  if (!stdout) {
    throw new Error(`${label} produced no JSON on stdout`);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} output must be valid JSON: ${error.message}`, {
      cause: error,
    });
  }
  return {
    value: parsed,
    path: "",
    sha256: sha256Text(stableJson(parsed)),
  };
}
