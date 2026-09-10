import path from "node:path";
import { readPackageJson } from "./package.js";
import { runNpm } from "./registry.js";
import { summarizePackPreview } from "./pack-preview.js";
const EXACT_TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function npmPublishDryRun(
  {
    cwd = process.cwd(),
    expectedTag = "",
    registry = "https://registry.npmjs.org/",
    distTag = "",
    skipNpmPublishDryRun = false,
    env = process.env,
  } = {},
  { execute = runNpm } = {},
) {
  const resolvedCwd = path.resolve(cwd);
  const pkg = readPackageJson(resolvedCwd);
  if (pkg.private === true) {
    throw new Error("package.json private must be false before npm publish");
  }
  if (!pkg.name || typeof pkg.name !== "string") {
    throw new Error("package.json name must be a non-empty string");
  }
  if (!pkg.version || typeof pkg.version !== "string") {
    throw new Error("package.json version must be a non-empty string");
  }
  const exactTag = `v${pkg.version}`;
  if (!EXACT_TAG_PATTERN.test(exactTag)) {
    throw new Error(`unsupported release tag for npm publish: ${exactTag}`);
  }
  if (expectedTag && expectedTag !== exactTag) {
    throw new Error(
      `npm publish tag must match package.json version: tag=${expectedTag} expected=${exactTag}`,
    );
  }
  const resolvedDistTag =
    distTag || (pkg.version.includes("-") ? "alpha" : "latest");
  const packCommand = execute({
    cwd: resolvedCwd,
    env,
    args: ["pack", "--dry-run", "--json", `--registry=${registry}`],
  });
  const pack = summarizePackPreview(packCommand.stdout);
  let publishCommand;
  if (!skipNpmPublishDryRun) {
    publishCommand = execute({
      cwd: resolvedCwd,
      env,
      args: [
        "publish",
        "--dry-run",
        "--access",
        "public",
        "--tag",
        resolvedDistTag,
        `--registry=${registry}`,
      ],
    });
  }
  const result = {
    schemaVersion: 1,
    dryRun: true,
    wouldPublish: !skipNpmPublishDryRun,
    package: {
      name: pkg.name,
      version: pkg.version,
      private: pkg.private === true,
    },
    exactTag,
    distTag: resolvedDistTag,
    registry,
    pack,
    commands: {
      pack: ["npm", "pack", "--dry-run", "--json", `--registry=${registry}`],
      publishDryRun: publishCommand
        ? [
            "npm",
            "publish",
            "--dry-run",
            "--access",
            "public",
            "--tag",
            resolvedDistTag,
            `--registry=${registry}`,
          ]
        : [],
    },
  };
  return result;
}
