import fs from "node:fs";
import path from "node:path";
import {
  DIGEST,
  NON_AUTHORITIES,
  MAX_MEDIA_MEMBER_BYTES,
  MAX_GATE_BUNDLE_BYTES,
  MAX_MEDIA_BUNDLE_BYTES,
  requireValue,
  stableJson,
  rootJson,
  regular,
  readJson,
  inside,
} from "./values.js";
import { validateScenario } from "./scenario.js";
import { materializeDemoPresentation } from "./presentation.js";
import {
  copyVerifiedRegular,
  verifyBundleChecksums,
} from "./bundle-verification.js";
function copyRegular(source, destination, label) {
  return copyVerifiedRegular(
    source,
    destination,
    label,
    MAX_MEDIA_MEMBER_BYTES,
  );
}

function replaceReadmeBlock(readme, marker, block) {
  const start = `<!-- ${marker}:start -->`;
  const end = `<!-- ${marker}:end -->`;
  const first = readme.indexOf(start);
  const last = readme.indexOf(end);
  requireValue(
    (first === -1) === (last === -1),
    "README materialization markers are incomplete",
  );
  if (first !== -1) {
    requireValue(
      readme.indexOf(start, first + start.length) === -1 &&
        readme.indexOf(end, last + end.length) === -1 &&
        last > first,
      "README materialization markers are ambiguous",
    );
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

function materializePublicDemoReadme({
  repository,
  evidenceDirectory,
  scenario,
  demo,
}) {
  const relative = path
    .relative(repository, evidenceDirectory)
    .split(path.sep)
    .join("/");
  const marker =
    scenario.demos.length === 1
      ? scenario.publication.marker
      : `${scenario.publication.marker}:${demo.id}`;
  const commandLines = demo.steps
    .map((step) =>
      `$ ${scenario.product.binaryName} ${step.argv.join(" ")}`.trim(),
    )
    .join("\n");
  const imageLine = `[![${demo.title}](${relative}/demo.gif)](${relative}/public-evidence.json)`;
  const evidenceBlock = [
    `<!-- ${marker}:start -->`,
    `## ${demo.title}`,
    "",
    imageLine,
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
  let block = evidenceBlock;
  let technicalSpecPath = "";
  if (scenario.presentation) {
    const materialized = materializeDemoPresentation({
      repository,
      scenario,
      demo,
      evidenceDirectory,
      imageLine,
      commandLines,
      inside,
      regular,
      replaceBlock: replaceReadmeBlock,
      requireValue,
    });
    block = [
      `<!-- ${marker}:start -->`,
      ...materialized.blockLines,
      `<!-- ${marker}:end -->`,
    ].join("\n");
    technicalSpecPath = materialized.technicalSpecPath;
  }
  const readmePath = inside(
    repository,
    scenario.publication.readmePath,
    "README path",
  );
  const readme = regular(readmePath, "README", 4 * 1024 * 1024).toString(
    "utf8",
  );
  fs.writeFileSync(readmePath, replaceReadmeBlock(readme, marker, block));

  return { relative, technicalSpecPath };
}

function copyPublicDemoEvidence({
  evidenceDirectory,
  mediaBundle,
  gateBundle,
  captureRoot,
}) {
  const publicFiles = [];
  for (const name of [
    "demo.gif",
    "demo.mp4",
    "demo.webm",
    "demo-720p.mp4",
    "demo-720p.webm",
    "poster.png",
    "media-receipt.json",
    "gate-receipt.json",
    "manifest.json",
    "media-inspection.json",
    "media-probe.json",
    "renderer-checksums.sha256",
  ]) {
    const source = path.join(path.resolve(mediaBundle), name);
    if (fs.existsSync(source))
      publicFiles.push(
        copyRegular(
          source,
          path.join(evidenceDirectory, name),
          `media ${name}`,
        ),
      );
  }
  copyRegular(
    path.join(path.resolve(gateBundle), "gate-receipt.json"),
    path.join(evidenceDirectory, "qualified-gate-receipt.json"),
    "qualified Gate receipt",
  );
  copyRegular(
    path.join(path.resolve(captureRoot), "manifest.json"),
    path.join(evidenceDirectory, "capture-manifest.json"),
    "capture manifest",
  );
  copyRegular(
    path.join(path.resolve(captureRoot), "source-coordinate.json"),
    path.join(evidenceDirectory, "source-coordinate.json"),
    "source coordinate",
  );

  return publicFiles;
}

export function materializeDemo({
  repositoryRoot,
  scenarioPath,
  demoId,
  captureRoot,
  gateBundle,
  mediaBundle,
  buildchainSha,
  rendererImage,
}) {
  const repository = path.resolve(repositoryRoot);
  const scenario = validateScenario(
    readJson(path.resolve(scenarioPath), "scenario"),
  );
  const demo = scenario.demos.find((entry) => entry.id === demoId);
  requireValue(demo, `unknown demo id: ${demoId}`);
  const captureManifest = readJson(
    path.join(path.resolve(captureRoot), "manifest.json"),
    "capture manifest",
  );
  requireValue(
    captureManifest.demo?.id === demoId &&
      captureManifest.scenarioRoot === rootJson(scenario),
    "capture does not bind the exact scenario demo",
  );
  const gateReceipt = readJson(
    path.join(path.resolve(gateBundle), "gate-receipt.json"),
    "gate receipt",
  );
  const mediaReceipt = readJson(
    path.join(path.resolve(mediaBundle), "media-receipt.json"),
    "media receipt",
  );
  const gateRoot = verifyBundleChecksums(gateBundle, "Gate bundle", {
    maximumBundleBytes: MAX_GATE_BUNDLE_BYTES,
  });
  requireValue(
    DIGEST.test(mediaReceipt.rendererManifestRoot),
    "media receipt renderer manifest root is invalid",
  );
  const mediaRoot = verifyBundleChecksums(mediaBundle, "media bundle", {
    allowLongFormRendererManifest:
      scenario.execution.durationClass === "long-form",
    maximumBundleBytes: MAX_MEDIA_BUNDLE_BYTES,
    maximumMemberBytes: MAX_MEDIA_MEMBER_BYTES,
    rendererManifestRoot: mediaReceipt.rendererManifestRoot,
  });
  requireValue(
    gateReceipt.status === "passed" && mediaReceipt.status === "passed",
    "Gate and media receipts must pass",
  );
  requireValue(
    mediaReceipt.qualifiedGateRoot === gateRoot,
    "media receipt is not bound to the exact qualified Gate",
  );
  const sourceCoordinate = readJson(
    path.join(path.resolve(captureRoot), "source-coordinate.json"),
    "source coordinate",
  );
  requireValue(
    rootJson(sourceCoordinate) === captureManifest.sourceCoordinateRoot,
    "source coordinate root mismatch",
  );
  requireValue(
    DIGEST.test(buildchainSha) || /^[0-9a-f]{40}$/u.test(buildchainSha),
    "Buildchain runtime coordinate is invalid",
  );
  requireValue(
    /@sha256:[0-9a-f]{64}$/u.test(rendererImage),
    "renderer image must be immutable",
  );
  const evidencePreimage = {
    schema: "buildchain.declarative-demo-evidence-root/v1",
    scenarioRoot: captureManifest.scenarioRoot,
    captureRoot: captureManifest.root,
    gateRoot,
    mediaRoot,
    demoId,
  };
  const evidenceRoot = rootJson(evidencePreimage);
  const evidenceDirectory = inside(
    repository,
    `${scenario.publication.evidencePath}/${evidenceRoot.slice(7)}/${demoId}`,
    "evidence directory",
  );
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const publicFiles = copyPublicDemoEvidence({
    evidenceDirectory,
    mediaBundle,
    gateBundle,
    captureRoot,
  });
  const passportBody = {
    schema: "buildchain.declarative-demo-release-passport/v1",
    status: "qualified",
    product: scenario.product,
    demo: { id: demo.id, title: demo.title, claimBoundary: demo.claimBoundary },
    evidenceRoot,
    scenarioRoot: captureManifest.scenarioRoot,
    capture: {
      root: captureManifest.root,
      binary: captureManifest.artifact,
      networkIsolation: captureManifest.networkIsolation,
    },
    source: sourceCoordinate,
    gate: { root: evidencePreimage.gateRoot },
    media: {
      root: evidencePreimage.mediaRoot,
      profile:
        mediaReceipt.qualification?.profile?.id || "responsive-web-delivery-v1",
      qualificationRoot:
        mediaReceipt.qualificationRoot ||
        mediaReceipt.qualification?.qualificationRoot ||
        "",
    },
    toolchain: { buildchainSha, rendererImage },
    authority: authorityBoundary(),
  };
  const passport = { ...passportBody, passportRoot: rootJson(passportBody) };
  fs.writeFileSync(
    path.join(evidenceDirectory, "release-passport.json"),
    stableJson(passport),
  );
  const publicEvidence = {
    ...evidencePreimage,
    evidenceRoot,
    passportRoot: passport.passportRoot,
    source: sourceCoordinate,
    files: publicFiles.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
  fs.writeFileSync(
    path.join(evidenceDirectory, "public-evidence.json"),
    stableJson(publicEvidence),
  );
  const { relative, technicalSpecPath } = materializePublicDemoReadme({
    repository,
    evidenceDirectory,
    scenario,
    demo,
  });
  return {
    ok: true,
    demoId,
    evidenceRoot,
    evidenceDirectory: relative,
    passportRoot: passport.passportRoot,
    technicalSpecPath,
  };
}
