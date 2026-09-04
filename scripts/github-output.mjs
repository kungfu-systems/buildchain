import crypto from "node:crypto";
import fs from "node:fs";

function githubOutputRecord(key, value) {
  const normalized = String(value ?? "");
  if (!/[\r\n]/u.test(normalized)) return `${key}=${normalized}\n`;
  const valueLines = normalized.split(/\r\n|\r|\n/u);
  let delimiter = `BUILDCHAIN_OUTPUT_${crypto
    .createHash("sha256")
    .update(`${key}\0${normalized}`)
    .digest("hex")}`;
  while (valueLines.includes(delimiter)) delimiter += "_";
  const separator = normalized.endsWith("\n") ? "" : "\n";
  return `${key}<<${delimiter}\n${normalized}${separator}${delimiter}\n`;
}

export function writeGitHubOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    for (const [key, value] of Object.entries(outputs)) {
      console.log(`${key}=${value}`);
    }
    return;
  }
  fs.appendFileSync(
    outputPath,
    Object.entries(outputs)
      .map(([key, value]) => githubOutputRecord(key, value))
      .join(""),
  );
}
