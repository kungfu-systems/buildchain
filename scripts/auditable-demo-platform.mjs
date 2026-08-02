#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SAFE_MARKER = /^[a-z0-9][a-z0-9._:-]{0,79}$/u;
const NON_AUTHORITIES = [
  "first-party-identity",
  "system-identity",
  "kfd-compliance",
  "product-system-metadata",
  "package-metadata",
  "registry-history",
  "scan-output",
  "standalone-generation",
];
const RENDITIONS = [
  { id: "1080p", role: "primary", columns: 150, rows: 36, width: 1920, height: 1080 },
  { id: "720p", role: "responsive", columns: 100, rows: 28, width: 1280, height: 720 },
];

function fail(message) {
  throw new Error(`auditable demo platform: ${message}`);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function rootBytes(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function rootJson(value) {
  return rootBytes(Buffer.from(stableJson(value)));
}

function regular(file, label, maximum = 8 * 1024 * 1024) {
  const metadata = fs.lstatSync(file);
  requireValue(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= maximum, `${label} must be a bounded regular file`);
  return fs.readFileSync(file);
}

function readJson(file, label) {
  try {
    const value = JSON.parse(regular(file, label).toString("utf8"));
    requireValue(value && typeof value === "object" && !Array.isArray(value), `${label} must contain an object`);
    return value;
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${label} is invalid JSON`);
    throw error;
  }
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

function verifyChecksums(root, label) {
  const resolved = path.resolve(root);
  const bytes = regular(path.join(resolved, "checksums.sha256"), `${label} checksums`);
  const rows = bytes.toString("utf8").split("\n").filter(Boolean);
  const declared = new Set();
  for (const row of rows) {
    const match = /^([0-9a-f]{64})  ([^\0\r\n]+)$/u.exec(row);
    requireValue(match, `${label} checksum row is invalid`);
    const target = inside(resolved, match[2], `${label} checksum member`);
    requireValue(!declared.has(match[2]), `${label} checksum member is repeated`);
    declared.add(match[2]);
    requireValue(rootBytes(regular(target, `${label} member`)) === `sha256:${match[1]}`, `${label} checksum mismatch: ${match[2]}`);
  }
  const actual = listBundleFiles(resolved).filter((name) => name !== "checksums.sha256");
  requireValue(JSON.stringify([...declared].sort()) === JSON.stringify(actual), `${label} checksum member set is not exact`);
  return rootBytes(bytes);
}

function inside(root, relative, label) {
  requireValue(typeof relative === "string" && relative && !path.isAbsolute(relative), `${label} must be relative`);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  requireValue(resolved !== resolvedRoot && resolved.startsWith(`${resolvedRoot}${path.sep}`), `${label} escapes its root`);
  return resolved;
}

function exactKeys(value, required, optional, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) requireValue(Object.hasOwn(value, key), `${label}.${key} is required`);
  for (const key of Object.keys(value)) requireValue(allowed.has(key), `${label}.${key} is not allowed`);
}

function validateProduct(product) {
  exactKeys(product, ["id", "displayName", "binaryName"], [], "scenario.product");
  requireValue(SAFE_ID.test(product.id), "scenario.product.id is invalid");
  requireValue(typeof product.displayName === "string" && product.displayName.length > 0 && product.displayName.length <= 80, "scenario.product.displayName is invalid");
  requireValue(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(product.binaryName), "scenario.product.binaryName is invalid");
}

function validateArtifact(artifact) {
  exactKeys(artifact, ["platformId", "binaryPath", "metadataPath", "metadataContract", "runtimeDependencies"], [], "scenario.artifact");
  requireValue(artifact.platformId === "linux-x64", "scenario artifact must be linux-x64");
  for (const key of ["binaryPath", "metadataPath"]) inside("/scenario-root", artifact[key], `scenario.artifact.${key}`);
  requireValue(typeof artifact.metadataContract === "string" && artifact.metadataContract.length > 0, "scenario artifact metadataContract is invalid");
  requireValue(Array.isArray(artifact.runtimeDependencies) && artifact.runtimeDependencies.length === 0, "scenario artifact must be standalone");
}

function validateExecution(execution) {
  exactKeys(execution, ["deterministic", "network", "secrets", "totalTimeoutSeconds", "environment"], [], "scenario.execution");
  requireValue(execution.deterministic === true && execution.network === "none" && execution.secrets === "none", "scenario execution must be deterministic, network-disabled, and secret-free");
  requireValue(Number.isInteger(execution.totalTimeoutSeconds) && execution.totalTimeoutSeconds >= 1 && execution.totalTimeoutSeconds <= 60, "scenario total timeout is invalid");
  requireValue(execution.environment && typeof execution.environment === "object" && !Array.isArray(execution.environment), "scenario environment must be an object");
  for (const [key, item] of Object.entries(execution.environment)) {
    requireValue(/^[A-Z][A-Z0-9_]{0,63}$/u.test(key) && typeof item === "string" && item.length <= 256, `scenario environment entry is invalid: ${key}`);
  }
}

function validateStep(step, stepLabel, stepIds) {
  exactKeys(step, ["id", "argv", "timeoutSeconds", "expectedExitCodes", "stdoutIncludes", "fileAssertions"], [], stepLabel);
  requireValue(SAFE_ID.test(step.id) && !stepIds.has(step.id), `${stepLabel}.id is invalid or repeated`);
  stepIds.add(step.id);
  requireValue(Array.isArray(step.argv) && step.argv.length >= 1 && step.argv.length <= 64 && step.argv.every((item) => typeof item === "string" && !item.includes("\0") && item.length <= 512), `${stepLabel}.argv is invalid`);
  requireValue(!Object.hasOwn(step, "command"), `${stepLabel} must not use a shell command string`);
  requireValue(Number.isInteger(step.timeoutSeconds) && step.timeoutSeconds >= 1 && step.timeoutSeconds <= 60, `${stepLabel}.timeoutSeconds is invalid`);
  requireValue(Array.isArray(step.expectedExitCodes) && step.expectedExitCodes.length >= 1 && step.expectedExitCodes.length <= 4 && step.expectedExitCodes.every((item) => Number.isInteger(item) && item >= 0 && item <= 255), `${stepLabel}.expectedExitCodes is invalid`);
  requireValue(Array.isArray(step.stdoutIncludes) && step.stdoutIncludes.every((item) => typeof item === "string" && item.length >= 1 && item.length <= 256), `${stepLabel}.stdoutIncludes is invalid`);
  requireValue(Array.isArray(step.fileAssertions) && step.fileAssertions.length <= 32, `${stepLabel}.fileAssertions is invalid`);
  for (const assertion of step.fileAssertions) {
    exactKeys(assertion, ["path", "jsonEquals"], [], `${stepLabel}.fileAssertions[]`);
    inside("/workspace", assertion.path, `${stepLabel} assertion path`);
    requireValue(assertion.jsonEquals && typeof assertion.jsonEquals === "object" && !Array.isArray(assertion.jsonEquals), `${stepLabel} jsonEquals is invalid`);
  }
}

function validateDemo(demo, index, demoIds) {
  const label = `scenario.demos[${index}]`;
  exactKeys(demo, ["id", "title", "claimBoundary", "steps"], [], label);
  requireValue(SAFE_ID.test(demo.id) && !demoIds.has(demo.id), `${label}.id is invalid or repeated`);
  demoIds.add(demo.id);
  requireValue(typeof demo.title === "string" && demo.title.length > 0 && demo.title.length <= 120, `${label}.title is invalid`);
  requireValue(typeof demo.claimBoundary === "string" && demo.claimBoundary.length > 0 && demo.claimBoundary.length <= 500, `${label}.claimBoundary is invalid`);
  requireValue(Array.isArray(demo.steps) && demo.steps.length >= 1 && demo.steps.length <= 12, `${label}.steps is invalid`);
  const stepIds = new Set();
  demo.steps.forEach((step, stepIndex) => validateStep(step, `${label}.steps[${stepIndex}]`, stepIds));
}

export function validateScenario(value) {
  exactKeys(value, ["schema", "product", "artifact", "execution", "renditions", "demos", "publication", "authority"], [], "scenario");
  requireValue(value.schema === "buildchain.declarative-binary-demo/v1", "unsupported scenario schema");
  validateProduct(value.product);
  validateArtifact(value.artifact);
  validateExecution(value.execution);
  requireValue(JSON.stringify(value.renditions) === JSON.stringify(RENDITIONS), "scenario must declare both native rendition profiles exactly");
  requireValue(Array.isArray(value.demos) && value.demos.length >= 1 && value.demos.length <= 8, "scenario requires 1 through 8 demos");
  const demoIds = new Set();
  value.demos.forEach((demo, index) => validateDemo(demo, index, demoIds));
  exactKeys(value.publication, ["evidencePath", "readmePath", "marker"], [], "scenario.publication");
  inside("/repository", value.publication.evidencePath, "scenario.publication.evidencePath");
  inside("/repository", value.publication.readmePath, "scenario.publication.readmePath");
  requireValue(SAFE_MARKER.test(value.publication.marker), "scenario publication marker is invalid");
  exactKeys(value.authority, ["grants", "nonAuthorities"], [], "scenario.authority");
  requireValue(JSON.stringify(value.authority) === JSON.stringify({ grants: [], nonAuthorities: NON_AUTHORITIES }), "scenario authority boundary is invalid");
  return value;
}

function validateCapture(capture, rendition, summaryRoot) {
  requireValue(capture.schema === "buildchain.declarative-terminal-capture/v1", "capture schema mismatch");
  requireValue(JSON.stringify(capture.dimensions) === JSON.stringify({ columns: rendition.columns, rows: rendition.rows }), "capture dimensions mismatch");
  requireValue(capture.completion?.status === "qualified" && capture.completion?.reportRoot === summaryRoot, "capture completion mismatch");
  requireValue(capture.exitCode === 0 && capture.authority?.classification === "volatile-terminal-observation", "capture authority or exit mismatch");
  requireValue(JSON.stringify(capture.authority) === JSON.stringify({ classification: "volatile-terminal-observation", grants: [], nonAuthorities: NON_AUTHORITIES }), "capture grants authority");
  requireValue(Array.isArray(capture.events) && capture.events.length === capture.completion.eventCount && capture.events.length > 0, "capture events mismatch");
  return capture;
}

function projection(capture, transcript, demo, rendition) {
  const lines = transcript.endsWith("\n") ? transcript.slice(0, -1).split("\n") : transcript.split("\n");
  const durationMs = Math.min(60000, capture.durationMs + 1000);
  const projected = {
    schema: "kungfu.terminal-capture/v1",
    command: capture.command,
    dimensions: capture.dimensions,
    durationMs: capture.durationMs,
    encoding: capture.encoding,
    events: capture.events,
    completion: capture.completion,
    exitCode: capture.exitCode,
    authority: capture.authority,
  };
  const scene = {
    schema: "build-images.demo-scene/v1",
    id: `${demo.id}-${rendition.id}`.slice(0, 64),
    width: rendition.width,
    height: rendition.height,
    fps: 15,
    durationMs,
    title: demo.title,
    commandLabel: capture.command,
    background: "#0B1020",
    accent: "#67E8A5",
  };
  const publicProjection = {
    schema: "build-images.demo-projection/v1",
    evidenceClass: "exact-standalone-binary-declarative-demo/v1",
    claimBoundary: demo.claimBoundary,
    cues: [{ startMs: 0, endMs: durationMs, transcriptLines: lines.slice(0, 80).map((_, index) => index + 1), annotation: "declared exact-binary scenario" }],
  };
  return { projected, scene, publicProjection };
}

function prepareOutput(output) {
  if (!fs.existsSync(output)) return fs.mkdirSync(output, { recursive: true });
  const metadata = fs.lstatSync(output);
  requireValue(metadata.isDirectory() && !metadata.isSymbolicLink() && fs.readdirSync(output).length === 0, "output must be an empty directory");
}

export function adaptCapture({ artifactRoot, output }) {
  const root = path.resolve(artifactRoot);
  const manifest = readJson(path.join(root, "manifest.json"), "capture manifest");
  requireValue(manifest.schema === "buildchain.declarative-demo-capture/v1" && manifest.status === "qualified", "capture manifest is not qualified");
  const declaredRoot = manifest.root;
  const { root: _root, ...manifestBody } = manifest;
  requireValue(DIGEST.test(declaredRoot) && rootJson(manifestBody) === declaredRoot, "capture manifest root mismatch");
  requireValue(manifest.authority?.grants?.length === 0 && JSON.stringify(manifest.authority?.nonAuthorities) === JSON.stringify(NON_AUTHORITIES), "capture manifest grants authority");
  requireValue(Array.isArray(manifest.renditions) && manifest.renditions.length === 2, "capture rendition set is invalid");
  prepareOutput(output);
  const set = [];
  for (const [index, expected] of RENDITIONS.entries()) {
    const descriptor = manifest.renditions[index];
    requireValue(descriptor.id === expected.id && descriptor.role === expected.role && descriptor.width === expected.width && descriptor.height === expected.height, `capture rendition ${index} mismatch`);
    const transcriptBytes = regular(inside(root, descriptor.transcript, "capture transcript"), "capture transcript", 4 * 1024 * 1024);
    const transcript = transcriptBytes.toString("utf8").replace(/\r\n/gu, "\n");
    requireValue(transcript.trim().length > 0, "capture transcript is empty");
    const summary = readJson(inside(root, descriptor.runSummary, "run summary"), "run summary");
    requireValue(rootJson(summary) === descriptor.runSummaryRoot, "run summary root mismatch");
    const captureBytes = regular(inside(root, descriptor.terminalCapture, "terminal capture"), "terminal capture", 4 * 1024 * 1024);
    const capture = validateCapture(JSON.parse(captureBytes.toString("utf8")), expected, descriptor.runSummaryRoot);
    requireValue(rootJson(capture) === descriptor.terminalCaptureRoot, "terminal capture root mismatch");
    const { projected, scene, publicProjection } = projection(capture, transcript, manifest.demo, expected);
    const suffix = index === 0 ? "" : "-720p";
    fs.writeFileSync(path.join(output, `complete-transcript${suffix}.txt`), transcript);
    fs.writeFileSync(path.join(output, `terminal-capture${suffix}.json`), stableJson(projected));
    fs.writeFileSync(path.join(output, `scene${suffix}.json`), stableJson(scene));
    fs.writeFileSync(path.join(output, `public-projection${suffix}.json`), stableJson(publicProjection));
    set.push({ id: expected.id, role: expected.role, transcript: `complete-transcript${suffix}.txt`, projection: `public-projection${suffix}.json`, scene: `scene${suffix}.json`, terminalCapture: `terminal-capture${suffix}.json`, captureRoot: rootJson(projected) });
  }
  requireValue(set[0].captureRoot !== set[1].captureRoot, "native rendition capture roots must differ");
  fs.writeFileSync(path.join(output, "rendition-set.json"), stableJson({
    schema: "kungfu.auditable-demo.rendition-set/v1",
    renditions: set,
    authority: { classification: "capture-routing-metadata", grants: [], nonAuthorities: ["publication-authority", "runtime-authority", ...NON_AUTHORITIES] },
  }));
  return { demoId: manifest.demo.id, captureRoot: declaredRoot, renditionRoots: set.map((entry) => entry.captureRoot) };
}

function copyRegular(source, destination, label) {
  const bytes = regular(source, label, 64 * 1024 * 1024);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
  return { path: path.basename(destination), bytes: bytes.length, root: rootBytes(bytes) };
}

function replaceReadmeBlock(readme, marker, block) {
  const start = `<!-- ${marker}:start -->`;
  const end = `<!-- ${marker}:end -->`;
  const first = readme.indexOf(start);
  const last = readme.indexOf(end);
  requireValue((first === -1) === (last === -1), "README materialization markers are incomplete");
  if (first !== -1) {
    requireValue(readme.indexOf(start, first + start.length) === -1 && readme.indexOf(end, last + end.length) === -1 && last > first, "README materialization markers are ambiguous");
    return `${readme.slice(0, first)}${block}${readme.slice(last + end.length)}`;
  }
  const headingEnd = readme.indexOf("\n");
  requireValue(headingEnd !== -1, "README must contain a title line");
  return `${readme.slice(0, headingEnd + 1)}\n${block}\n${readme.slice(headingEnd + 1)}`;
}

function authorityBoundary() {
  return {
    grants: [],
    nonAuthorities: NON_AUTHORITIES,
    authorizationSources: [
      "exact-release-passport",
      "core-policy",
      "work-or-warrant",
      "explicit-capability-grant",
      "runtime-isolation",
    ],
    productSystemRole: "assembly-and-distribution-metadata-only",
  };
}

export function materializeDemo({ repositoryRoot, scenarioPath, demoId, captureRoot, gateBundle, mediaBundle, buildchainSha, rendererImage }) {
  const repository = path.resolve(repositoryRoot);
  const scenario = validateScenario(readJson(path.resolve(scenarioPath), "scenario"));
  const demo = scenario.demos.find((entry) => entry.id === demoId);
  requireValue(demo, `unknown demo id: ${demoId}`);
  const captureManifest = readJson(path.join(path.resolve(captureRoot), "manifest.json"), "capture manifest");
  requireValue(captureManifest.demo?.id === demoId && captureManifest.scenarioRoot === rootJson(scenario), "capture does not bind the exact scenario demo");
  const gateReceipt = readJson(path.join(path.resolve(gateBundle), "gate-receipt.json"), "gate receipt");
  const mediaReceipt = readJson(path.join(path.resolve(mediaBundle), "media-receipt.json"), "media receipt");
  const gateRoot = verifyChecksums(gateBundle, "Gate bundle");
  const mediaRoot = verifyChecksums(mediaBundle, "media bundle");
  requireValue(gateReceipt.status === "passed" && mediaReceipt.status === "passed", "Gate and media receipts must pass");
  requireValue(mediaReceipt.qualifiedGateRoot === gateRoot, "media receipt is not bound to the exact qualified Gate");
  const sourceCoordinate = readJson(path.join(path.resolve(captureRoot), "source-coordinate.json"), "source coordinate");
  requireValue(rootJson(sourceCoordinate) === captureManifest.sourceCoordinateRoot, "source coordinate root mismatch");
  requireValue(DIGEST.test(buildchainSha) || /^[0-9a-f]{40}$/u.test(buildchainSha), "Buildchain runtime coordinate is invalid");
  requireValue(/@sha256:[0-9a-f]{64}$/u.test(rendererImage), "renderer image must be immutable");
  const evidencePreimage = {
    schema: "buildchain.declarative-demo-evidence-root/v1",
    scenarioRoot: captureManifest.scenarioRoot,
    captureRoot: captureManifest.root,
    gateRoot,
    mediaRoot,
    demoId,
  };
  const evidenceRoot = rootJson(evidencePreimage);
  const evidenceDirectory = inside(repository, `${scenario.publication.evidencePath}/${evidenceRoot.slice(7)}/${demoId}`, "evidence directory");
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const publicFiles = [];
  for (const name of ["demo.gif", "demo.mp4", "demo.webm", "demo-720p.mp4", "demo-720p.webm", "poster.png", "media-receipt.json", "gate-receipt.json", "manifest.json", "media-inspection.json", "media-probe.json", "renderer-checksums.sha256"]) {
    const source = path.join(path.resolve(mediaBundle), name);
    if (fs.existsSync(source)) publicFiles.push(copyRegular(source, path.join(evidenceDirectory, name), `media ${name}`));
  }
  copyRegular(path.join(path.resolve(gateBundle), "gate-receipt.json"), path.join(evidenceDirectory, "qualified-gate-receipt.json"), "qualified Gate receipt");
  copyRegular(path.join(path.resolve(captureRoot), "manifest.json"), path.join(evidenceDirectory, "capture-manifest.json"), "capture manifest");
  copyRegular(path.join(path.resolve(captureRoot), "source-coordinate.json"), path.join(evidenceDirectory, "source-coordinate.json"), "source coordinate");
  const passportBody = {
    schema: "buildchain.declarative-demo-release-passport/v1",
    status: "qualified",
    product: scenario.product,
    demo: { id: demo.id, title: demo.title, claimBoundary: demo.claimBoundary },
    evidenceRoot,
    scenarioRoot: captureManifest.scenarioRoot,
    capture: { root: captureManifest.root, binary: captureManifest.artifact, networkIsolation: captureManifest.networkIsolation },
    source: sourceCoordinate,
    gate: { root: evidencePreimage.gateRoot },
    media: { root: evidencePreimage.mediaRoot, profile: mediaReceipt.qualification?.profile?.id || "responsive-web-delivery-v1", qualificationRoot: mediaReceipt.qualificationRoot || mediaReceipt.qualification?.qualificationRoot || "" },
    toolchain: { buildchainSha, rendererImage },
    authority: authorityBoundary(),
  };
  const passport = { ...passportBody, passportRoot: rootJson(passportBody) };
  fs.writeFileSync(path.join(evidenceDirectory, "release-passport.json"), stableJson(passport));
  const publicEvidence = { ...evidencePreimage, evidenceRoot, passportRoot: passport.passportRoot, source: sourceCoordinate, files: publicFiles.sort((left, right) => left.path.localeCompare(right.path)) };
  fs.writeFileSync(path.join(evidenceDirectory, "public-evidence.json"), stableJson(publicEvidence));
  const relative = path.relative(repository, evidenceDirectory).split(path.sep).join("/");
  const marker = scenario.publication.marker;
  const commandLines = demo.steps.map((step) => `$ ${scenario.product.binaryName} ${step.argv.join(" ")}`.trim()).join("\n");
  const block = [
    `<!-- ${marker}:start -->`,
    `## ${demo.title}`,
    "",
    `[![${demo.title}](${relative}/demo.gif)](${relative}/public-evidence.json)`,
    "",
    "Animation scenario:",
    "",
    "```text",
    commandLines,
    "```",
    "",
    `Native renditions: [1080p MP4](${relative}/demo.mp4) · [1080p WebM](${relative}/demo.webm) · [720p MP4](${relative}/demo-720p.mp4) · [720p WebM](${relative}/demo-720p.webm)`,
    "",
    `[Static poster / reduced-motion fallback](${relative}/poster.png)`,
    "",
    "<details>",
    "<summary>Evidence and claim boundary</summary>",
    "",
    `${demo.claimBoundary}`,
    "",
    `[Release Passport](${relative}/release-passport.json) · [auditable evidence](${relative}/public-evidence.json)`,
    "",
    "</details>",
    `<!-- ${marker}:end -->`,
  ].join("\n");
  const readmePath = inside(repository, scenario.publication.readmePath, "README path");
  const readme = regular(readmePath, "README", 4 * 1024 * 1024).toString("utf8");
  fs.writeFileSync(readmePath, replaceReadmeBlock(readme, marker, block));
  return { ok: true, demoId, evidenceRoot, evidenceDirectory: relative, passportRoot: passport.passportRoot };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    requireValue(key?.startsWith("--") && value !== undefined && !(key in values), `invalid argument near ${key || "<empty>"}`);
    values[key.slice(2)] = value;
  }
  return values;
}

function main(argv = process.argv.slice(2)) {
  const directAdapter = argv[0]?.startsWith("--");
  const [command, ...rest] = directAdapter ? ["adapt", ...argv] : argv;
  const args = parseArgs(rest);
  if (command === "validate") {
    const scenario = validateScenario(readJson(path.resolve(args.scenario), "scenario"));
    process.stdout.write(stableJson({ ok: true, scenarioRoot: rootJson(scenario), demoIds: scenario.demos.map((entry) => entry.id) }));
    return;
  }
  if (command === "list") {
    const scenario = validateScenario(readJson(path.resolve(args.scenario), "scenario"));
    process.stdout.write(`${scenario.demos.map((entry) => entry.id).join("\n")}\n`);
    return;
  }
  if (command === "publication") {
    const scenario = validateScenario(readJson(path.resolve(args.scenario), "scenario"));
    process.stdout.write(stableJson(scenario.publication));
    return;
  }
  if (command === "adapt") {
    const result = adaptCapture({ artifactRoot: path.resolve(args["artifact-root"]), output: path.resolve(args.output) });
    process.stdout.write(stableJson({ ok: true, ...result }));
    return;
  }
  if (command === "materialize") {
    const result = materializeDemo({
      repositoryRoot: path.resolve(args.repository),
      scenarioPath: path.resolve(args.scenario),
      demoId: args["demo-id"],
      captureRoot: path.resolve(args.capture),
      gateBundle: path.resolve(args.gate),
      mediaBundle: path.resolve(args.media),
      buildchainSha: args["buildchain-sha"],
      rendererImage: args["renderer-image"],
    });
    process.stdout.write(stableJson(result));
    return;
  }
  fail(`unknown command: ${command || "<empty>"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
