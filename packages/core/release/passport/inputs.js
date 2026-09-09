import {
  resolveJsonInputPath,
  readJsonFile,
  jsonInputError,
  sha256File,
} from "./files.js";
import { sha256Text, stableJson } from "./json.js";
export function parseJsonInput(
  value,
  fallback = undefined,
  { cwd = process.cwd(), label = "JSON input" } = {},
) {
  const input = String(value || "").trim();
  if (!input) {
    return fallback;
  }
  const filePath = resolveJsonInputPath(input, { cwd });
  if (filePath) {
    return readJsonFile(filePath);
  }
  try {
    return JSON.parse(input);
  } catch (error) {
    throw jsonInputError({ input, label, cwd, cause: error });
  }
}
export function parseJsonInputWithMeta(
  value,
  fallback = undefined,
  { cwd = process.cwd(), label = "JSON input" } = {},
) {
  const input = String(value || "").trim();
  if (!input) {
    return { value: fallback, path: "", sha256: "" };
  }
  const filePath = resolveJsonInputPath(input, { cwd });
  if (filePath) {
    return {
      value: readJsonFile(filePath),
      path: input,
      sha256: sha256File(filePath),
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw jsonInputError({ input, label, cwd, cause: error });
  }
  return {
    value: parsed,
    path: "",
    sha256: sha256Text(stableJson(parsed)),
  };
}
