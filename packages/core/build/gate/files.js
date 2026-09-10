import fs from "node:fs";
import path from "node:path";
export function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

export function readJson(file, label = file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${label}: ${error.message}`);
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function commandForPlatform(commandJson, platform) {
  const parsed = parseJson(commandJson, "gate-command-json");
  const argv = Array.isArray(parsed) ? parsed : parsed?.[platform];
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some((item) => typeof item !== "string" || !item)
  ) {
    throw new Error(
      `gate-command-json requires a non-empty argv array for ${platform}`,
    );
  }
  return argv;
}

export function findNamedFiles(root, basename) {
  if (!fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return path.basename(root) === basename ? [root] : [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => findNamedFiles(path.join(root, entry.name), basename));
}
