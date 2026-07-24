#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHANNELS = new Set(["auto", "alpha", "stable"]);
const STABLE_PUBLISH_CHANNELS = new Set(["release", "major"]);
const OFFICIAL_REF = /^v(\d+)(?:\.\d+)?(?:-alpha)?$/;
const EXACT_SHA = /^[0-9a-f]{40}$/i;
const TRAIN_REF = /^(?:refs\/heads\/)?train\/v(\d+)\/v\d+\.\d+\/[A-Za-z0-9._/-]+$/;
const SEMVER_TAG = /^refs\/tags\/v?\d+\.\d+\.\d+(?:-([0-9A-Za-z.-]+))?$/;

function normalized(value) {
  return String(value ?? "").trim();
}

function parseBoolean(value, name) {
  const text = normalized(value).toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function readPackageVersion(cwd) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version || "";
  } catch {
    return "";
  }
}

function majorFrom(value) {
  const text = normalized(value).replace(/^refs\/(?:heads|tags)\//, "");
  const official = text.match(OFFICIAL_REF);
  if (official) return Number(official[1]);
  const train = text.match(TRAIN_REF);
  if (train) return Number(train[1]);
  const embedded = text.match(/(?:^|\/)v(\d+)(?:$|[./-])/);
  if (embedded) return Number(embedded[1]);
  const version = text.match(/^(\d+)\.\d+\.\d+/);
  return version ? Number(version[1]) : undefined;
}

function resolveMajor({ requestedRef, routerRef, packageVersion }) {
  for (const candidate of [requestedRef, routerRef, packageVersion]) {
    const major = majorFrom(candidate);
    if (Number.isInteger(major)) return major;
  }
  throw new Error("unable to derive the Buildchain major; call the router from a vN ref or provide a vN buildchain-ref");
}

function classifyRequestedRef(value) {
  const ref = normalized(value).replace(/^refs\/(?:heads|tags)\//, "");
  if (!ref) return { kind: "none", ref };
  if (EXACT_SHA.test(ref)) return { kind: "override", ref };
  if (TRAIN_REF.test(value) || TRAIN_REF.test(ref)) {
    return { kind: "override", ref: normalized(value).replace(/^refs\/heads\//, "") };
  }
  const official = ref.match(OFFICIAL_REF);
  if (official) {
    return {
      kind: ref.endsWith("-alpha") ? "alpha" : "stable",
      ref,
      major: Number(official[1]),
    };
  }
  throw new Error("buildchain-ref must be an official vN/vN.M channel, a train ref, or an exact 40-character SHA");
}

function selected(channel, major, source, reason) {
  return {
    channel,
    major,
    buildchainRef: channel === "alpha" ? `v${major}-alpha` : `v${major}`,
    selectionSource: source,
    reason,
  };
}

export function resolveBuildchainChannel({
  requestedChannel = "auto",
  requestedRef = "",
  publishChannel = "none",
  eventName = "",
  gitRef = "",
  releasePrerelease = "",
  routerRef = "",
  packageVersion = "",
} = {}) {
  const channel = normalized(requestedChannel || "auto").toLowerCase();
  if (!CHANNELS.has(channel)) {
    throw new Error("buildchain-channel must be auto, alpha, or stable");
  }

  const explicitRef = classifyRequestedRef(requestedRef);
  const major = resolveMajor({ requestedRef: explicitRef.ref, routerRef, packageVersion });
  if (explicitRef.kind !== "none") {
    if (channel !== "auto" && explicitRef.kind !== "override" && channel !== explicitRef.kind) {
      throw new Error(`buildchain-channel=${channel} conflicts with buildchain-ref=${explicitRef.ref}`);
    }
    if (channel !== "auto" && explicitRef.kind === "override") {
      throw new Error("train and exact-SHA buildchain-ref overrides require buildchain-channel=auto");
    }
    return {
      channel: explicitRef.kind,
      major,
      buildchainRef: explicitRef.ref,
      selectionSource: "explicit-buildchain-ref",
      reason: `explicit Buildchain runtime ref ${explicitRef.ref}`,
    };
  }

  if (channel !== "auto") {
    return selected(channel, major, "explicit-channel", `explicit buildchain-channel=${channel}`);
  }

  const publishing = normalized(publishChannel || "none").toLowerCase();
  if (publishing === "alpha") {
    return selected("alpha", major, "publish-channel", "publish-channel=alpha");
  }
  if (STABLE_PUBLISH_CHANNELS.has(publishing)) {
    return selected("stable", major, "publish-channel", `publish-channel=${publishing}`);
  }
  if (publishing !== "none") {
    throw new Error(`custom publish-channel=${publishing} requires an explicit buildchain-channel`);
  }

  if (eventName === "release") {
    if (normalized(releasePrerelease) === "") {
      throw new Error("release events require github.event.release.prerelease to select a Buildchain channel");
    }
    const prerelease = parseBoolean(releasePrerelease, "releasePrerelease");
    return selected(
      prerelease ? "alpha" : "stable",
      major,
      "release-event",
      prerelease ? "GitHub prerelease event" : "GitHub stable release event",
    );
  }

  const ref = normalized(gitRef);
  if (ref.startsWith("refs/tags/")) {
    const tag = ref.match(SEMVER_TAG);
    if (!tag) {
      throw new Error(`tag ${ref} is not a canonical semver release tag; set buildchain-channel explicitly`);
    }
    return selected(
      tag[1] ? "alpha" : "stable",
      major,
      "semver-tag",
      tag[1] ? `prerelease tag ${ref}` : `stable tag ${ref}`,
    );
  }

  return selected("alpha", major, "development-default", `non-release ${eventName || "unknown"} event`);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function appendOutputs(file, result) {
  const entries = {
    channel: result.channel,
    major: String(result.major),
    "buildchain-ref": result.buildchainRef,
    "selection-source": result.selectionSource,
    reason: result.reason,
  };
  fs.appendFileSync(file, Object.entries(entries).map(([key, value]) => `${key}=${value}\n`).join(""));
}

function appendSummary(file, result) {
  fs.appendFileSync(
    file,
    [
      "## Buildchain channel router",
      "",
      `- selected channel: \`${result.channel}\``,
      `- selected runtime ref: \`${result.buildchainRef}\``,
      `- selection source: \`${result.selectionSource}\``,
      `- reason: ${result.reason}`,
      "",
    ].join("\n"),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = path.resolve(args.cwd || process.cwd());
  const result = resolveBuildchainChannel({
    requestedChannel: args.channel,
    requestedRef: args["buildchain-ref"],
    publishChannel: args["publish-channel"],
    eventName: args["event-name"],
    gitRef: args.ref,
    releasePrerelease: args["release-prerelease"],
    routerRef: args["router-ref"],
    packageVersion: readPackageVersion(cwd),
  });
  if (process.env.GITHUB_OUTPUT) appendOutputs(process.env.GITHUB_OUTPUT, result);
  if (process.env.GITHUB_STEP_SUMMARY) appendSummary(process.env.GITHUB_STEP_SUMMARY, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`buildchain-channel-router: ${error.message}`);
    process.exitCode = 1;
  });
}
