import fs from "node:fs";
import path from "node:path";

export const MAJOR_GATE_REF = "publish-gate/major";
export const LEGACY_MAJOR_GATE_REF = "major-gate";
export const MAJOR_GATE_CHANNEL = "major";

export function normalizeRef(ref) {
  return String(ref || "").replace(/^refs\/heads\//, "");
}

export function isMajorGateRef(ref) {
  const normalizedRef = normalizeRef(ref);
  return normalizedRef === MAJOR_GATE_REF || normalizedRef === LEGACY_MAJOR_GATE_REF;
}

export function parseVersionStateRef(ref) {
  const normalizedRef = normalizeRef(ref);
  if (/^buildchain\/version-state\/publish-gate-major\/[0-9a-f]{12,40}$/.test(normalizedRef)) {
    return {
      channel: MAJOR_GATE_CHANNEL,
      normalizedRef: MAJOR_GATE_REF,
      lineSuffix: "",
    };
  }

  if (/^buildchain\/version-state\/major-gate\/[0-9a-f]{12,40}$/.test(normalizedRef)) {
    return {
      channel: MAJOR_GATE_CHANNEL,
      normalizedRef: LEGACY_MAJOR_GATE_REF,
      lineSuffix: "",
    };
  }

  const match = normalizedRef.match(
    /^buildchain\/version-state\/(alpha|release)-v(\d+)-v(\d+\.\d+)\/[0-9a-f]{12,40}$/,
  );
  if (!match) return undefined;
  return {
    channel: match[1],
    major: Number(match[2]),
    loose: Number(match[3]),
    normalizedRef: `${match[1]}/v${match[2]}/v${match[3]}`,
    lineSuffix: `/v${match[2]}/v${match[3]}`,
  };
}

export function parseReleaseLineRecoveryRef(ref) {
  const normalizedRef = normalizeRef(ref);
  const match = normalizedRef.match(/^fix\/release-line-v(\d+)-v(\d+\.\d+)-[0-9A-Za-z._-]+$/);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    loose: Number(match[2]),
    normalizedRef: `release/v${match[1]}/v${match[2]}`,
    lineSuffix: `/v${match[1]}/v${match[2]}`,
  };
}

export function parsePublishGateChannelRef(ref) {
  const normalizedRef = normalizeRef(ref);
  const match = normalizedRef.match(/^publish-gate\/(alpha|release)\/(v(\d+)\/v(\d+\.\d+))\/[^/]+$/);
  if (!match) return undefined;
  return {
    channel: match[1],
    major: Number(match[3]),
    loose: Number(match[4]),
    normalizedRef: `${match[1]}/${match[2]}`,
    lineSuffix: `/${match[2]}`,
  };
}

export function getChannel(ref) {
  const versionStateTarget = parseVersionStateRef(ref);
  if (versionStateTarget) return versionStateTarget.channel;
  const publishGateTarget = parsePublishGateChannelRef(ref);
  if (publishGateTarget) return publishGateTarget.channel;
  const normalizedRef = normalizeRef(ref);
  if (isMajorGateRef(normalizedRef)) return MAJOR_GATE_CHANNEL;
  return normalizedRef.split("/")[0];
}

export function getLineSuffix(ref, channel) {
  const versionStateTarget = parseVersionStateRef(ref);
  if (versionStateTarget) return versionStateTarget.lineSuffix;
  const publishGateTarget = parsePublishGateChannelRef(ref);
  if (publishGateTarget) return publishGateTarget.lineSuffix;
  if (isMajorGateRef(ref)) return "";
  return normalizeRef(ref).replace(channel, "");
}

export function readCurrentVersion(cwd = process.cwd()) {
  const packagePath = path.join(cwd, fs.existsSync(path.join(cwd, "lerna.json")) ? "lerna.json" : "package.json");
  const config = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  return parseVersion(config.version);
}

export function parseVersion(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    throw new Error(`Invalid version: ${value}`);
  }
  return {
    version: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export function getBumpKeyword({ cwd = process.cwd(), headRef, baseRef, loose = false } = {}) {
  const version = readCurrentVersion(cwd);
  const looseVersionNumber = Number(`${version.major}.${version.minor}`);
  const lastLooseVersionNumber = Number((looseVersionNumber - 0.1).toFixed(1));
  const versionStateTarget = parseVersionStateRef(headRef);
  const releaseLineRecoveryTarget = parseReleaseLineRecoveryRef(headRef);
  const publishGateTarget = parsePublishGateChannelRef(headRef);
  const headChannel = getChannel(headRef);
  const baseChannel = getChannel(baseRef);
  const key = `${headChannel}->${baseChannel}`;
  const keywords = {
    "dev->alpha": "prerelease",
    "alpha->release": "patch",
    "release->major": "premajor",
    "release->release": "preminor",
  };

  const lts = baseChannel === "release" && normalizeRef(baseRef).split("/").pop() === "lts";
  const preminor = headChannel === "release" && lts;
  const majorGate = headChannel === "release" && baseChannel === MAJOR_GATE_CHANNEL;

  if (releaseLineRecoveryTarget) {
    if (baseChannel !== "release" || releaseLineRecoveryTarget.normalizedRef !== normalizeRef(baseRef)) {
      throw new Error(`Versions not match for head/base refs: ${headRef} -> ${baseRef}`);
    }
    const mismatchMsg = `The version of head ref ${headRef} does not match current ${version.version}`;
    if (releaseLineRecoveryTarget.major !== version.major || releaseLineRecoveryTarget.loose !== looseVersionNumber) {
      throw new Error(mismatchMsg);
    }
    return "patch";
  }

  if (publishGateTarget) {
    if (publishGateTarget.channel !== baseChannel || publishGateTarget.normalizedRef !== normalizeRef(baseRef)) {
      throw new Error(`Versions not match for head/base refs: ${headRef} -> ${baseRef}`);
    }
    const mismatchMsg = `The version of head ref ${headRef} does not match current ${version.version}`;
    if (publishGateTarget.major !== version.major || publishGateTarget.loose !== looseVersionNumber) {
      throw new Error(mismatchMsg);
    }
    return baseChannel === "release" ? "patch" : "prerelease";
  }

  if (getLineSuffix(headRef, headChannel) !== getLineSuffix(baseRef, baseChannel) && !preminor && !majorGate) {
    throw new Error(`Versions not match for head/base refs: ${headRef} -> ${baseRef}`);
  }

  if (versionStateTarget) {
    if (versionStateTarget.channel !== baseChannel) {
      throw new Error(`Versions not match for head/base refs: ${headRef} -> ${baseRef}`);
    }
    return baseChannel === "release" || baseChannel === MAJOR_GATE_CHANNEL ? "patch" : "prerelease";
  }

  const normalizedHeadRef = normalizeRef(headRef);
  const headMatch = normalizedHeadRef.match(/(\w+)\/v(\d+)\/v(\d+\.\d)/);
  const mismatchMsg = `The version of head ref ${headRef} does not match current ${version.version}`;

  if (!headMatch) {
    throw new Error(mismatchMsg);
  }

  const headMajor = Number(headMatch[2]);
  const headLoose = Number(headMatch[3]);

  if (headMajor !== version.major || headLoose > looseVersionNumber) {
    throw new Error(mismatchMsg);
  }

  if (headLoose < lastLooseVersionNumber) {
    throw new Error(mismatchMsg);
  }

  if (headLoose === lastLooseVersionNumber && !loose) {
    throw new Error(mismatchMsg);
  }

  const keyword = keywords[key];
  if (!keyword) {
    throw new Error(`No rule to bump for head/base refs: ${headRef} -> ${baseRef}`);
  }
  return keyword;
}
