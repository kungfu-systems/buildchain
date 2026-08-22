#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createV4PublicationRehearsalCapsule,
  executeV4PublicationRehearsal,
} from "../packages/core/v4-publication-rehearsal.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(
  root,
  "contracts/fixtures/v4-publication-rehearsal-v1",
);
const candidateRoot = path.join(fixtureRoot, "candidate");

function digest(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function candidateFiles() {
  const roles = {
    "artifacts/product.bin": "installable-product",
    "config/buildchain.toml": "buildchain-config",
    "documents/release-activation.json": "release-activation-document",
    "documents/signed-channel.json": "signed-channel-document",
    "evidence/qualification.json": "qualification-evidence",
    "manifests/candidate.json": "candidate-manifest",
    "manifests/release-passport.json": "release-passport",
  };
  return Object.keys(roles)
    .map((relative) => {
      const bytes = fs.readFileSync(path.join(candidateRoot, relative));
      return {
        role: roles[relative],
        path: relative,
        size: bytes.length,
        root: digest(bytes),
      };
    })
    .sort((left, right) =>
      Buffer.from(left.path).compare(Buffer.from(right.path)),
    );
}

async function generated() {
  const declaration = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        "contracts/fixtures/release-tail-capabilities-v1/kungfu-alpha.json",
      ),
      "utf8",
    ),
  );
  const files = candidateFiles();
  const binding = (relative) => ({
    path: relative,
    root: files.find((entry) => entry.path === relative).root,
  });
  const capsule = createV4PublicationRehearsalCapsule({
    source: {
      repository: "kungfu-systems/buildchain",
      revision: "bc12cd0ff18a7e1d918777ea093c169349952d34",
    },
    declaration,
    manifest: binding("manifests/candidate.json"),
    config: binding("config/buildchain.toml"),
    providerBindings: {
      schema: "kungfu.buildchain.release-tail.provider-bindings/v1",
      artifacts: {
        "installable-product": {
          path: "artifacts/product.bin",
          name: "product.bin",
        },
        "release-passport": {
          path: "manifests/release-passport.json",
          name: "release-passport.json",
        },
      },
      documents: {
        "release.activate": {
          path: "documents/release-activation.json",
          method: "PUT",
        },
        "signed-channel.commit": {
          path: "documents/signed-channel.json",
          method: "PUT",
        },
      },
      evidence: {
        inputs: ["evidence/qualification.json"],
        output: "generated/released-evidence.json",
      },
    },
    files,
  });
  const vectors = [];
  for (const platform of ["linux", "macos", "windows"]) {
    const result = await executeV4PublicationRehearsal({
      capsule,
      candidateRoot,
      mode: "simulate",
    });
    vectors.push({
      platform,
      capsuleRoot: result.evidence.capsuleRoot,
      transactionRoot: result.evidence.transactionRoot,
      stateRoot: result.evidence.stateRoot,
      evidenceRoot: result.evidence.evidenceRoot,
    });
  }
  return {
    capsule,
    vectors: {
      schema: "buildchain-v4-publication-rehearsal-offline-vectors/v1",
      vectors,
      vectorRoot: digest(JSON.stringify(vectors)),
    },
  };
}

const { capsule, vectors } = await generated();
const outputs = new Map([
  [path.join(fixtureRoot, "capsule.json"), capsule],
  [path.join(fixtureRoot, "offline-vectors.json"), vectors],
]);
const check = process.argv.includes("--check");
for (const [file, value] of outputs) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (check) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== bytes)
      throw new Error(`${path.relative(root, file)} is stale`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
}
process.stdout.write(
  `${JSON.stringify({ capsuleRoot: capsule.capsuleRoot, vectorRoot: vectors.vectorRoot })}\n`,
);
