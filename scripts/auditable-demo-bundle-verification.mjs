#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MAX_LONG_FORM_RENDERER_MANIFEST_BYTES, readRendererManifest } from "./auditable-demo-renditions.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAX_METADATA_MEMBER_BYTES = 8 * 1024 * 1024;
const MAX_TERMINAL_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_TERMINAL_CAPTURE_EVENTS = 10_000;
const DIGEST_BUFFER_BYTES = 64 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function fail(message) {
  throw new Error(`auditable demo platform: ${message}`);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function rootBytes(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function boundedRegular(file, label, maximum) {
  const metadata = fs.lstatSync(file);
  requireValue(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= maximum, `${label} must be a bounded regular file`);
  return metadata;
}

function readRegular(file, label, maximum = MAX_METADATA_MEMBER_BYTES) {
  boundedRegular(file, label, maximum);
  return fs.readFileSync(file);
}

function digestRegular(file, label, maximum) {
  const expected = boundedRegular(file, label, maximum);
  const descriptor = fs.openSync(file, "r");
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(DIGEST_BUFFER_BYTES);
  let bytes = 0;
  try {
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytes += count;
      requireValue(bytes <= maximum, `${label} must be a bounded regular file`);
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  requireValue(bytes === expected.size, `${label} changed while it was verified`);
  return { bytes, root: `sha256:${hash.digest("hex")}` };
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8.decode(bytes);
  } catch {
    fail(`${label} must be valid UTF-8`);
  }
}

function inside(root, relative, label) {
  requireValue(typeof relative === "string" && relative && !path.isAbsolute(relative), `${label} must be relative`);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  requireValue(resolved !== resolvedRoot && resolved.startsWith(`${resolvedRoot}${path.sep}`), `${label} escapes its root`);
  return resolved;
}

function listBundleFiles(root, prefix = "") {
  const entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const files = [];
  for (const entry of entries) {
    requireValue(!entry.isSymbolicLink(), `bundle member must not be a symbolic link: ${path.join(prefix, entry.name)}`);
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...listBundleFiles(root, relative));
    else {
      requireValue(entry.isFile(), `bundle member must be a regular file: ${relative}`);
      files.push(relative.split(path.sep).join("/"));
    }
  }
  return files;
}

const RENDERER_MANIFEST_HELPERS = {
  decodeUtf8,
  digestPattern: DIGEST,
  invariant: requireValue,
  maxBytes: MAX_TERMINAL_CAPTURE_BYTES,
  maxEvents: MAX_TERMINAL_CAPTURE_EVENTS,
  readRegular,
};

export function verifyBundleChecksums(root, label, options = {}) {
  const resolved = path.resolve(root);
  const checksums = readRegular(path.join(resolved, "checksums.sha256"), `${label} checksums`);
  const declared = new Set();
  const members = [];
  let bundleBytes = 0;
  for (const row of checksums.toString("utf8").split("\n").filter(Boolean)) {
    const match = /^([0-9a-f]{64})  ([^\0\r\n]+)$/u.exec(row);
    requireValue(match, `${label} checksum row is invalid`);
    const target = inside(resolved, match[2], `${label} checksum member`);
    requireValue(!declared.has(match[2]), `${label} checksum member is repeated`);
    declared.add(match[2]);
    const metadataMember = match[2].endsWith(".json") || match[2].endsWith(".sha256");
    const maximum = options.allowLongFormRendererManifest && match[2] === "manifest.json"
      ? MAX_LONG_FORM_RENDERER_MANIFEST_BYTES
      : metadataMember
        ? MAX_METADATA_MEMBER_BYTES
        : (options.maximumMemberBytes || MAX_METADATA_MEMBER_BYTES);
    bundleBytes += boundedRegular(target, `${label} member`, maximum).size;
    requireValue(bundleBytes <= options.maximumBundleBytes, `${label} exceeds its aggregate byte budget`);
    members.push({ expectedRoot: `sha256:${match[1]}`, maximum, name: match[2], target });
  }
  for (const member of members) {
    const verified = options.allowLongFormRendererManifest && member.name === "manifest.json"
      ? (() => {
          const value = readRendererManifest(member.target, RENDERER_MANIFEST_HELPERS).bytes;
          return { bytes: value.length, root: rootBytes(value) };
        })()
      : digestRegular(member.target, `${label} member`, member.maximum);
    requireValue(verified.root === member.expectedRoot, `${label} checksum mismatch: ${member.name}`);
    if (member.name === "manifest.json" && options.rendererManifestRoot) {
      requireValue(verified.root === options.rendererManifestRoot, `${label} renderer manifest root mismatch`);
    }
  }
  const actual = listBundleFiles(resolved).filter((name) => name !== "checksums.sha256");
  requireValue(JSON.stringify([...declared].sort()) === JSON.stringify(actual), `${label} checksum member set is not exact`);
  return rootBytes(checksums);
}

export function copyVerifiedRegular(source, destination, label, maximum) {
  const sourceDigest = digestRegular(source, label, maximum);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  const destinationDigest = digestRegular(destination, `${label} copy`, maximum);
  requireValue(destinationDigest.bytes === sourceDigest.bytes && destinationDigest.root === sourceDigest.root, `${label} copy differs from its verified source`);
  return { path: path.basename(destination), bytes: destinationDigest.bytes, root: destinationDigest.root };
}
