#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXACT_TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readArg(argv, name, fallback = "") {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return argv[index + 1] || "";
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function readEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

function runNpm({ cwd, args, allowFailure = false }) {
  const result = spawnSync("npm", args, {
    cwd,
    env: process.env,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (!allowFailure && result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed\n${result.stdout || ""}${result.stderr || ""}`.trim());
  }
  return result;
}

function readPackageJson(cwd) {
  const filePath = path.join(cwd, "package.json");
  if (!fs.existsSync(filePath)) {
    throw new Error(`package.json not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parsePackResult(stdout) {
  const parsed = JSON.parse(stdout);
  const pack = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!pack?.name || !pack?.version) {
    throw new Error("npm pack did not return package name and version");
  }
  return {
    name: pack.name,
    version: pack.version,
    filename: pack.filename || "",
    integrity: pack.integrity || "",
    shasum: pack.shasum || "",
    entryCount: pack.entryCount || pack.files?.length || 0,
  };
}

function artifactDigest(pack) {
  if (pack.integrity) {
    return pack.integrity;
  }
  if (pack.shasum) {
    return `sha1:${pack.shasum}`;
  }
  throw new Error("npm pack did not return integrity or shasum");
}

function parseNpmView(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) {
    return undefined;
  }
  const parsed = JSON.parse(raw);
  const dist = parsed?.dist || parsed;
  return {
    integrity: dist?.integrity || "",
    shasum: dist?.shasum || "",
  };
}

function publishedDigest({ cwd, name, version, registry }) {
  const result = runNpm({
    cwd,
    args: ["view", `${name}@${version}`, "dist.integrity", "dist.shasum", "--json", `--registry=${registry}`],
    allowFailure: true,
  });
  if (result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (/\bE404\b|404 Not Found|is not in this registry/i.test(output)) {
      return undefined;
    }
    throw new Error(`npm view ${name}@${version} failed\n${output}`.trim());
  }
  const view = parseNpmView(result.stdout);
  if (!view) {
    return undefined;
  }
  return view.integrity || (view.shasum ? `sha1:${view.shasum}` : "");
}

function assertPackageVersion({ pkg, expectedVersion }) {
  if (pkg.private === true) {
    throw new Error("package.json private must be false before npm publish");
  }
  if (!pkg.name || typeof pkg.name !== "string") {
    throw new Error("package.json name must be a non-empty string");
  }
  if (!pkg.version || typeof pkg.version !== "string") {
    throw new Error("package.json version must be a non-empty string");
  }
  if (expectedVersion && pkg.version !== expectedVersion) {
    throw new Error(`package.json version must match Buildchain version: package=${pkg.version} buildchain=${expectedVersion}`);
  }
  const exactTag = `v${pkg.version}`;
  if (!EXACT_TAG_PATTERN.test(exactTag)) {
    throw new Error(`unsupported release tag for npm publish: ${exactTag}`);
  }
  return exactTag;
}

function writeEvidence({ cwd, evidencePath, evidence }) {
  const resolved = path.resolve(cwd, evidencePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(evidence, null, 2)}\n`);
  return resolved;
}

function writeGitHubOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  fs.appendFileSync(outputPath, Object.entries(outputs)
    .map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, " ")}`)
    .join("\n") + "\n");
}

export function npmPublishTransaction({
  cwd = process.cwd(),
  registry = "https://registry.npmjs.org/",
  dryRunPublish = false,
  access = "public",
  skipRegistryLookup = false,
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const pkg = readPackageJson(resolvedCwd);
  const expectedVersion = readEnv("BUILDCHAIN_VERSION");
  const exactTag = assertPackageVersion({ pkg, expectedVersion });
  const distTag = pkg.version.includes("-") ? "alpha" : "latest";

  const pack = parsePackResult(runNpm({
    cwd: resolvedCwd,
    args: ["pack", "--dry-run", "--json", `--registry=${registry}`],
  }).stdout);
  const digest = artifactDigest(pack);

  const existingDigest = skipRegistryLookup
    ? undefined
    : publishedDigest({
        cwd: resolvedCwd,
        name: pkg.name,
        version: pkg.version,
        registry,
      });
  let publishAction = "already-published";
  if (existingDigest) {
    if (existingDigest !== digest) {
      throw new Error(`artifact digest mismatch: npm:${pkg.name}@${pkg.version}`);
    }
  } else if (dryRunPublish) {
    publishAction = "dry-run";
  } else {
    runNpm({
      cwd: resolvedCwd,
      args: ["publish", "--access", access, "--tag", distTag, `--registry=${registry}`],
    });
    publishAction = "published";
    const registryDigest = skipRegistryLookup
      ? undefined
      : publishedDigest({
          cwd: resolvedCwd,
          name: pkg.name,
          version: pkg.version,
          registry,
        });
    if (registryDigest && registryDigest !== digest) {
      throw new Error(`artifact digest mismatch: npm:${pkg.name}@${pkg.version}`);
    }
  }

  const evidencePath = readEnv("BUILDCHAIN_PUBLISH_EVIDENCE");
  if (!evidencePath) {
    throw new Error("BUILDCHAIN_PUBLISH_EVIDENCE is required");
  }
  const evidence = {
    schema: 1,
    version: expectedVersion || pkg.version,
    channel: readEnv("BUILDCHAIN_CHANNEL"),
    source_sha: readEnv("BUILDCHAIN_SOURCE_SHA"),
    release_sha: readEnv("BUILDCHAIN_RELEASE_SHA"),
    target_ref: readEnv("BUILDCHAIN_TARGET_REF"),
    release_material_sha: readEnv("BUILDCHAIN_RELEASE_MATERIAL_SHA", readEnv("BUILDCHAIN_RELEASE_SHA")),
    publish_tooling_sha: readEnv("BUILDCHAIN_PUBLISH_TOOLING_SHA", readEnv("BUILDCHAIN_RELEASE_SHA")),
    artifacts: [{
      group: "node",
      kind: "npm",
      name: pkg.name,
      ref: pkg.version,
      digest,
    }],
  };
  const resolvedEvidencePath = writeEvidence({ cwd: resolvedCwd, evidencePath, evidence });
  writeGitHubOutputs({
    version: pkg.version,
    "exact-tag": exactTag,
    "dist-tag": distTag,
    "artifact-digest": digest,
    "publish-action": publishAction,
    "publish-evidence": resolvedEvidencePath,
  });
  return {
    schemaVersion: 1,
    package: {
      name: pkg.name,
      version: pkg.version,
    },
    exactTag,
    distTag,
    registry,
    publishAction,
    pack,
    evidencePath: resolvedEvidencePath,
    evidence,
  };
}

function usage() {
  return `Usage:
  node scripts/npm-publish-transaction.mjs [--cwd <dir>] [--registry <url>]
                                           [--dry-run-publish] [--skip-registry-lookup]
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const argv = process.argv.slice(2);
    if (hasFlag(argv, "help") || argv.includes("-h")) {
      process.stdout.write(usage());
      process.exit(0);
    }
    const result = npmPublishTransaction({
      cwd: readArg(argv, "cwd", process.cwd()),
      registry: readArg(argv, "registry", "https://registry.npmjs.org/"),
      dryRunPublish: hasFlag(argv, "dry-run-publish"),
      skipRegistryLookup: hasFlag(argv, "skip-registry-lookup"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(`npm-publish-transaction: ${error.message}`);
    process.exitCode = 1;
  }
}
