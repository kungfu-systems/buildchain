import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PUBLICATION_REPRODUCIBILITY_RECEIPT_CONTRACT,
  verifyPublicationReproducibility,
} from "../packages/core/publication-reproducibility.js";

const fixtureRoot = path.resolve("fixtures/publication-artifact-shaped");
const bin = path.resolve("bin/buildchain.mjs");

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Buildchain Test",
      GIT_AUTHOR_EMAIL: "buildchain-test@example.invalid",
      GIT_COMMITTER_NAME: "Buildchain Test",
      GIT_COMMITTER_EMAIL: "buildchain-test@example.invalid",
      GIT_AUTHOR_DATE: "2026-07-30T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-07-30T00:00:00Z",
    },
  }).trim();
}

function tempPublicationRepo({
  nondeterministic = false,
  nested = false,
} = {}) {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-publication-repro-test-"),
  );
  const cwd = nested
    ? path.join(repositoryRoot, "papers", "fixture")
    : repositoryRoot;
  fs.mkdirSync(cwd, { recursive: true });
  fs.cpSync(fixtureRoot, cwd, { recursive: true });
  const configPath = path.join(cwd, ".buildchain", "buildchain.toml");
  fs.appendFileSync(
    configPath,
    `

[publication.toolchain]
type = "custom-command"
command = "make pdf"

[publish]
kind = "npm-paper-package"
package = "@kungfu-tech/paper-observer-declared-timelines"
auth = "trusted-publishing"
`,
  );
  const makefilePath = path.join(cwd, "Makefile");
  fs.writeFileSync(
    makefilePath,
    fs
      .readFileSync(makefilePath, "utf8")
      .replace(
        "printf '%s\\n' '%PDF-1.4 fixture' > _build/main.pdf",
        "printf '%s\\n' '%PDF-1.4 fixture' '/CreationDate (D:20260730000000Z)' '/ModDate (D:20260730000000Z)' '/ID [<0011> <0011>]' > _build/main.pdf",
      ),
  );
  if (nondeterministic) {
    fs.writeFileSync(
      makefilePath,
      fs
        .readFileSync(makefilePath, "utf8")
        .replace(
          "> _build/main.pdf",
          "> _build/main.pdf && git rev-parse --show-toplevel >> _build/main.pdf",
        ),
    );
  }
  git(repositoryRoot, "init", "--quiet");
  git(
    repositoryRoot,
    "remote",
    "add",
    "origin",
    "https://github.com/kungfu-systems/paper-observer-declared-timelines.git",
  );
  git(repositoryRoot, "add", ".");
  git(repositoryRoot, "commit", "--quiet", "-m", "test: publication fixture");
  return { cwd, repositoryRoot };
}

test("publication reproducibility compares two clean builds and exact npm tarball bytes", () => {
  const { cwd, repositoryRoot } = tempPublicationRepo();
  try {
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          bin,
          "publication-artifact",
          "reproducibility",
          "--cwd",
          cwd,
          "--no-toolchain-pull",
          "--allow-unpinned-toolchain",
          "--promote",
          "--json",
        ],
        { cwd, encoding: "utf8" },
      ),
    );

    assert.equal(result.contract, PUBLICATION_REPRODUCIBILITY_RECEIPT_CONTRACT);
    assert.equal(result.status, "passed", JSON.stringify(result.issues));
    assert.equal(result.qualifying, false);
    assert.equal(result.builds.length, 2);
    assert.equal(
      result.builds[0].workspace.class,
      "independent-local-git-clone",
    );
    assert.equal(
      result.builds[0].sourceBundle.sha256,
      result.builds[1].sourceBundle.sha256,
    );
    assert.equal(result.builds[0].sourceBundleArchive.normalized, true);
    assert.equal(
      result.builds[0].sourceBundleArchive.entries.every(
        (entry) => String(entry.mtime) === result.source.sourceDateEpoch,
      ),
      true,
    );
    assert.deepEqual(result.builds[0].artifacts[0].pdfMetadata.creationDates, [
      "D:20260730000000Z",
    ]);
    assert.equal(
      result.builds[0].artifacts[0].pdfMetadata.metadataRoot,
      result.builds[1].artifacts[0].pdfMetadata.metadataRoot,
    );
    assert.equal(
      result.builds[0].npmPackage.integrity,
      result.builds[1].npmPackage.integrity,
    );
    assert.equal(
      result.builds[0].npmPackage.sha256,
      result.builds[1].npmPackage.sha256,
    );
    assert.equal(
      result.builds[0].outputSetRoot,
      result.builds[1].outputSetRoot,
    );
    assert.equal(result.comparison.firstDifference, null);
    assert.equal(
      result.issues.some(
        (issue) => issue.code === "toolchain-not-machine-verifiable",
      ),
      true,
    );
    assert.equal(fs.existsSync(path.join(cwd, result.outputPath)), true);
    assert.equal(fs.existsSync(path.join(cwd, "_build/main.pdf")), true);
    assert.equal(
      fs.existsSync(
        path.join(cwd, ".buildchain/publication/npm-package/package.json"),
      ),
      true,
    );
    const promotedTarball = path.join(
      cwd,
      ".buildchain/publication/npm-tarball",
      result.builds[0].npmPackage.filename,
    );
    assert.equal(fs.existsSync(promotedTarball), true);
    assert.equal(
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(promotedTarball))
        .digest("hex"),
      result.builds[0].npmPackage.sha256,
    );
    const repeated = verifyPublicationReproducibility({
      cwd,
      pullToolchain: false,
    });
    assert.equal(repeated.status, "passed");
    assert.equal(repeated.receiptDigest, result.receiptDigest);
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("publication reproducibility reports the first byte-level artifact difference", () => {
  const { cwd, repositoryRoot } = tempPublicationRepo({
    nondeterministic: true,
  });
  try {
    const result = verifyPublicationReproducibility({
      cwd,
      pullToolchain: false,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.qualifying, false);
    assert.equal(
      result.comparison.firstDifference.key,
      "artifact:_build/main.pdf",
    );
    assert.equal(result.comparison.firstDifference.field, "sha256");
    assert.notEqual(
      result.comparison.firstDifference.firstBuild,
      result.comparison.firstDifference.secondBuild,
    );
    assert.equal(
      result.issues.some((issue) => issue.code === "publication-bytes-differ"),
      true,
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("publication reproducibility preserves a repository-relative project working directory", () => {
  const { cwd, repositoryRoot } = tempPublicationRepo({
    nested: true,
  });
  try {
    const result = verifyPublicationReproducibility({
      cwd,
      pullToolchain: false,
    });

    assert.equal(result.status, "passed");
    assert.equal(result.source.projectPath, "papers/fixture");
    assert.equal(result.source.repositoryRoot, undefined);
    assert.equal(result.builds.length, 2);
  } finally {
    fs.rmSync(repositoryRoot, {
      recursive: true,
      force: true,
    });
  }
});
