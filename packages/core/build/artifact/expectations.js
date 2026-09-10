import { parseJsonObject } from "../../contracts/structured-values.js";
import path from "node:path";
export function parseExpectedArtifactsJson(value = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const expected = parseJsonObject(raw, "expected-artifacts-json");
  const normalized = {};
  if (expected.minFiles !== undefined) {
    normalized.minFiles = Number(expected.minFiles);
    if (!Number.isInteger(normalized.minFiles) || normalized.minFiles < 0) {
      throw new Error(
        "expected-artifacts-json.minFiles must be a non-negative integer",
      );
    }
  }
  if (expected.maxFiles !== undefined) {
    normalized.maxFiles = Number(expected.maxFiles);
    if (!Number.isInteger(normalized.maxFiles) || normalized.maxFiles < 0) {
      throw new Error(
        "expected-artifacts-json.maxFiles must be a non-negative integer",
      );
    }
  }
  if (expected.minTotalBytes !== undefined) {
    normalized.minTotalBytes = Number(expected.minTotalBytes);
    if (
      !Number.isInteger(normalized.minTotalBytes) ||
      normalized.minTotalBytes < 0
    ) {
      throw new Error(
        "expected-artifacts-json.minTotalBytes must be a non-negative integer",
      );
    }
  }
  if (expected.requiredPaths !== undefined) {
    if (!Array.isArray(expected.requiredPaths)) {
      throw new Error("expected-artifacts-json.requiredPaths must be an array");
    }
    normalized.requiredPaths = expected.requiredPaths.map((entry, index) => {
      const pathValue = String(entry || "")
        .replace(/\\/g, "/")
        .trim();
      if (!pathValue) {
        throw new Error(
          `expected-artifacts-json.requiredPaths[${index}] must be non-empty`,
        );
      }
      return pathValue;
    });
  }
  return normalized;
}

export function validateExpectedArtifacts({ expected, files, summary }) {
  if (!expected) {
    return { ok: true, source: "none", checks: [] };
  }
  const checks = [];
  const paths = new Set(files.map((file) => file.path));
  function addCheck(name, ok, detail) {
    checks.push({ name, ok, detail });
    if (!ok) {
      throw new Error(`expected artifact check failed: ${name}: ${detail}`);
    }
  }

  if (expected.minFiles !== undefined) {
    addCheck(
      "minFiles",
      summary.fileCount >= expected.minFiles,
      `${summary.fileCount} >= ${expected.minFiles}`,
    );
  }
  if (expected.maxFiles !== undefined) {
    addCheck(
      "maxFiles",
      summary.fileCount <= expected.maxFiles,
      `${summary.fileCount} <= ${expected.maxFiles}`,
    );
  }
  if (expected.minTotalBytes !== undefined) {
    addCheck(
      "minTotalBytes",
      summary.totalBytes >= expected.minTotalBytes,
      `${summary.totalBytes} >= ${expected.minTotalBytes}`,
    );
  }
  for (const requiredPath of expected.requiredPaths || []) {
    addCheck("requiredPath", paths.has(requiredPath), requiredPath);
  }
  return { ok: true, source: "expected-artifacts-json", checks };
}
