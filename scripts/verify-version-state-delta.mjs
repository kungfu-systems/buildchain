import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { invokeV4DomainWasm } from "../packages/core/v4-domain-wasm.js";

const execute = (command, args, options = {}) =>
  execFileSync(command, args, {
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });

// Reconstruct with the protected base's generator. No candidate command runs.
export function verifyVersionStateDelta({
  baseSha,
  headSha,
  cwd = process.cwd(),
  nodeModules = path.resolve("node_modules"),
}) {
  if (![baseSha, headSha].every((value) => /^[a-f0-9]{40}$/u.test(value || "")))
    throw new Error("version-state verification requires exact commits");
  const git = (...args) => execute("git", args, { cwd }).toString().trim();
  const bytes = (revision, file) =>
    execute("git", ["show", `${revision}:${file}`], { cwd });
  git("merge-base", "--is-ancestor", baseSha, headSha);
  const changes = git("diff", "--raw", "--no-renames", baseSha, headSha)
    .split("\n")
    .filter(Boolean);
  if (!changes.length) throw new Error("no version-state delta");
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-version-state-"),
  );
  const source = path.join(temporary, "source");
  try {
    fs.mkdirSync(source);
    const archive = path.join(temporary, "base.tar");
    git("-c", "core.autocrlf=false", "-c", "core.eol=lf", "archive", "--format=tar", `--output=${archive}`, baseSha);
    execute("tar", ["-xf", "base.tar", "-C", "source"], { cwd: temporary });
    fs.symlinkSync(nodeModules, path.join(source, "node_modules"), "junction");
    const planSource = `
      import fs from 'node:fs';
      import { loadBuildchainConfig, discoverConfiguredVersionStateFiles,
        updateConfiguredVersionStateContents } from './packages/core/buildchain-config.js';
      const config = loadBuildchainConfig(process.cwd());
      const files = discoverConfiguredVersionStateFiles(process.cwd(), config);
      const allowed = [...new Set([...files.map(f => f.path), ...config.config.version.derivedFiles])];
      if (JSON.stringify(config.config.lifecycle['version-state'].commands) !== JSON.stringify(['node scripts/generate-site-bundle.mjs']))
        throw new Error('unsupported version-state generator');
      if (process.env.BUILDCHAIN_DELTA_VERSION)
        for (const f of updateConfiguredVersionStateContents(files, process.env.BUILDCHAIN_DELTA_VERSION))
          fs.writeFileSync(f.path, f.content);
      console.log(JSON.stringify(allowed));
    `;
    const plan = (version = "") =>
      JSON.parse(
        execute(process.execPath, ["--input-type=module", "-e", planSource], {
          cwd: source,
          env: { ...process.env, BUILDCHAIN_DELTA_VERSION: version },
        }),
      );
    const allowed = plan();
    for (const file of allowed)
      if (path.isAbsolute(file) || file.split(/[\\/]/u).includes(".."))
        throw new Error("unsafe declared version-state path");
    for (const change of changes) {
      const match = change.match(
        /^:100644 100644 [a-f0-9]+ [a-f0-9]+ M\t(.+)$/u,
      );
      if (!match || !allowed.includes(match[1]))
        throw new Error(
          "delta includes undeclared source, lock, config or file mode changes",
        );
    }
    const version = JSON.parse(bytes(headSha, "package.json")).version;
    invokeV4DomainWasm("source-version-projection", {
      baseVersion: JSON.parse(bytes(baseSha, "package.json")).version,
      version,
    });
    const metadata = JSON.parse(bytes(headSha, "dist/site/site-manifest.json"));
    if (
      metadata.sourceRevision !== baseSha ||
      metadata.package.version !== version ||
      !Number.isFinite(Date.parse(metadata.generatedAt)) ||
      metadata.generatedAt !== metadata.publishedAt
    )
      throw new Error(
        "version-state projection source metadata is not bound to base",
      );
    plan(version);
    execute(process.execPath, ["scripts/generate-site-bundle.mjs"], {
      cwd: source,
      env: {
        ...process.env,
        BUILDCHAIN_SOURCE_SHA: baseSha,
        BUILDCHAIN_SITE_GENERATED_AT: metadata.generatedAt,
        BUILDCHAIN_SITE_PUBLISHED_AT: metadata.publishedAt,
        BUILDCHAIN_SITE_TIMESTAMP_POLICY: "ci-injected",
        BUILDCHAIN_SURFACE_GENERATED_AT: metadata.generatedAt,
        BUILDCHAIN_SURFACE_PUBLISHED_AT: metadata.publishedAt,
        SOURCE_DATE_EPOCH: "0",
      },
    });
    // Git blob hashes compare all tracked bytes without executing candidate code.
    const expected = new Map(
      git("ls-tree", "-r", headSha)
        .split("\n")
        .map((line) => {
          const [meta, file] = line.split("\t");
          return [file, meta.split(" ")[2]];
        }),
    );
    for (const [file, digest] of expected) {
      const generated = path.join(source, file);
      const bytes = fs.lstatSync(generated).isSymbolicLink()
        ? Buffer.from(fs.readlinkSync(generated))
        : fs.readFileSync(generated);
      const actual = crypto
        .createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      if (actual !== digest)
        throw new Error(`version-state regeneration mismatch: ${file}`);
    }
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (absolute === path.join(source, "node_modules")) continue;
        if (entry.isDirectory()) walk(absolute);
        else if (
          !expected.has(
            path.relative(source, absolute).split(path.sep).join("/"),
          )
        )
          throw new Error("version-state generator created undeclared output");
      }
    };
    walk(source);
    return {
      validationKind: "version-state-projection",
      baseSha,
      headSha,
      sourceTree: git("rev-parse", `${headSha}^{tree}`),
      version,
      changedPaths: changes.map((change) => change.split("\t")[1]),
      generator: "scripts/generate-site-bundle.mjs",
      generatedAt: metadata.generatedAt,
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(
      JSON.stringify(
        verifyVersionStateDelta({
          baseSha: process.argv[2],
          headSha: process.argv[3],
        }),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
