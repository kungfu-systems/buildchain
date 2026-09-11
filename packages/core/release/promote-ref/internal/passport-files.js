import fs from "node:fs";
import path from "node:path";
import { verifyReleasePassport } from "../../release-passport.js";
export function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}
export function toRepoRelative(cwd, filePath) {
  return path.relative(cwd, filePath).split(path.sep).join("/");
}
export function readJsonFileIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}
export function existingJsonObjectFile(filePath) {
  const content = readJsonFileIfExists(filePath);
  return content && typeof content === "object" && !Array.isArray(content)
    ? filePath
    : "";
}
export function releasePassportArtifactFiles(outputDir) {
  if (!outputDir || !fs.existsSync(outputDir)) {
    return [];
  }
  const durableTextExtensions = new Set([
    ".json",
    ".jsonl",
    ".md",
    ".sha256",
    ".txt",
    ".yaml",
    ".yml",
  ]);
  return fs
    .readdirSync(outputDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name === "SHA256SUMS" ||
          durableTextExtensions.has(path.extname(entry.name).toLowerCase())),
    )
    .map((entry) => {
      const filePath = path.join(outputDir, entry.name);
      return {
        path: `release-passport/${entry.name}`,
        content: fs.readFileSync(filePath, "utf8"),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}
export function backfillReleasePassportStateSha(outputDir, releaseStateSha) {
  if (!outputDir || !releaseStateSha) {
    return undefined;
  }
  const passportPath = path.join(outputDir, "buildchain.release.json");
  const passport = readJsonFileIfExists(passportPath);
  if (!passport || typeof passport !== "object" || Array.isArray(passport)) {
    return undefined;
  }
  passport.release =
    passport.release &&
    typeof passport.release === "object" &&
    !Array.isArray(passport.release)
      ? passport.release
      : {};
  passport.release.releaseStateSha = releaseStateSha;
  writeJsonFile(passportPath, passport);
  return passportPath;
}
export function summarizeReleasePassportIssues(report) {
  return (Array.isArray(report?.issues) ? report.issues : [])
    .filter((entry) => entry?.level === "error")
    .map((entry) => {
      const code = entry?.code || "unknown";
      const message = entry?.message || "release passport verification error";
      return `${code}: ${message}`;
    })
    .join("; ");
}
export async function verifyCollectedReleasePassport({
  collected,
  cwd,
  phase = "generated",
}) {
  const passportPath = path.join(
    collected.outputDir,
    "buildchain.release.json",
  );
  const relativePassportPath = path
    .relative(cwd, passportPath)
    .split(path.sep)
    .join("/");
  if (collected.checkReport?.ok !== true) {
    const issues = summarizeReleasePassportIssues(collected.checkReport);
    throw new Error(
      `Release passport ${phase} check failed for ${relativePassportPath}${issues ? `: ${issues}` : ""}`,
    );
  }
  const report = await verifyReleasePassport({
    passportLocation: passportPath,
  });
  if (report.ok !== true) {
    const issues = summarizeReleasePassportIssues(report);
    throw new Error(
      `Release passport ${phase} verification failed for ${relativePassportPath}${issues ? `: ${issues}` : ""}`,
    );
  }
  return report;
}
