import { getPromotionRule } from "./promotion-policy.js";
import { discoverVersionStateFiles } from "../../version-state.js";
import { releaseTransactionStateRef } from "../../publish-transaction.js";
export function latestAlphaForPatch(refs, releasePrefix, patch) {
  return alphaTagsForPatch(refs, releasePrefix, patch)[0];
}
export function alphaTagsForPatch(refs, releasePrefix, patch) {
  return refs
    .map((ref) => {
      const parsed = parseAlphaPrereleaseTag(ref.ref, releasePrefix);
      if (!parsed || parsed.patch !== patch) {
        return undefined;
      }
      return { ...parsed, sha: ref.object?.sha };
    })
    .filter(Boolean)
    .sort((a, b) => b.prerelease - a.prerelease);
}
export function ownsMajorAlphaChannel({ refs = [], major, minor }) {
  const floatingPattern = new RegExp(`^refs/tags/v${major}\\.(\\d+)-alpha$`);
  const exactPattern = new RegExp(
    `^refs/tags/v${major}\\.(\\d+)\\.\\d+-alpha\\.\\d+$`,
  );
  let highestPublishedMinor = -1;
  for (const ref of refs) {
    const refName = String(ref?.ref || "");
    const match = refName.match(floatingPattern) || refName.match(exactPattern);
    if (match) {
      highestPublishedMinor = Math.max(highestPublishedMinor, Number(match[1]));
    }
  }
  return Number(minor) >= highestPublishedMinor;
}
export function resolveTagsForTarget(targetRef, inputTags) {
  const rule = getPromotionRule(targetRef);
  if (rule.channel === "major" && (!inputTags || inputTags.length === 0)) {
    return [];
  }
  if (rule.channel === "major") {
    for (const tag of inputTags) {
      if (
        !/^v\d+$|^v\d+-alpha$|^v\d+\.0$|^v\d+\.0-alpha$|^v\d+\.0\.\d+$|^v\d+\.0\.\d+-alpha\.\d+$/.test(
          tag,
        )
      ) {
        throw new Error(
          `Tag ${tag} is not allowed for publish-gate/major promotion`,
        );
      }
    }
    return inputTags;
  }
  const tags = inputTags && inputTags.length > 0 ? inputTags : rule.tags;
  for (const tag of tags) {
    const isLineReleaseTag =
      tag.startsWith(`${rule.releasePrefix}.`) && !tag.includes("-alpha.");
    const isLineAlphaTag =
      tag === rule.alphaTag ||
      (tag.startsWith(`${rule.releasePrefix}.`) && tag.includes("-alpha."));
    const allowed =
      rule.channel === "release"
        ? tag === rule.majorTag ||
          tag === rule.majorAlphaTag ||
          tag === rule.minorTag ||
          tag === rule.alphaTag ||
          isLineReleaseTag ||
          isLineAlphaTag
        : tag === rule.majorAlphaTag || tag === rule.alphaTag || isLineAlphaTag;
    if (!allowed) {
      throw new Error(
        `Tag ${tag} is not allowed for ${rule.channel} promotion`,
      );
    }
  }
  return tags;
}
export function parseReleasePatchTag(refName, releasePrefix) {
  const match = String(refName || "").match(
    new RegExp(`^refs/tags/${releasePrefix.replace(".", "\\.")}\\.(\\d+)$`),
  );
  if (!match) {
    return undefined;
  }
  return {
    tag: refName.replace(/^refs\/tags\//, ""),
    patch: Number(match[1]),
  };
}
export function parseReleaseTransactionStateRef(refName, releasePrefix) {
  const statePrefix = releasePrefix.replace(/^v/, "").replaceAll(".", "-");
  const match = String(refName || "").match(
    new RegExp(`^refs/heads/buildchain/release-state/${statePrefix}-(\\d+)$`),
  );
  if (!match) {
    return undefined;
  }
  return {
    tag: `${releasePrefix}.${Number(match[1])}`,
    patch: Number(match[1]),
    occupied: true,
  };
}
export function parseAlphaPrereleaseTag(refName, releasePrefix) {
  const match = String(refName || "").match(
    new RegExp(
      `^refs/tags/${releasePrefix.replace(".", "\\.")}\\.(\\d+)-alpha\\.(\\d+)$`,
    ),
  );
  if (!match) {
    return undefined;
  }
  return {
    tag: refName.replace(/^refs\/tags\//, ""),
    patch: Number(match[1]),
    prerelease: Number(match[2]),
  };
}
export function parseAlphaPrereleaseVersion(version, releasePrefix) {
  return parseAlphaPrereleaseTag(`refs/tags/v${version}`, releasePrefix);
}
export function parseAlphaTransactionStateRef(refName, releasePrefix) {
  const statePrefix = releasePrefix.replace(/^v/, "").replaceAll(".", "-");
  const match = String(refName || "").match(
    new RegExp(
      `^refs/heads/buildchain/release-state/${statePrefix}-(\\d+)-alpha-(\\d+)$`,
    ),
  );
  if (!match) {
    return undefined;
  }
  return {
    tag: `${releasePrefix}.${Number(match[1])}-alpha.${Number(match[2])}`,
    patch: Number(match[1]),
    prerelease: Number(match[2]),
    occupied: true,
  };
}
export function getVersionFileValue(file) {
  if (file.type === "json" || file.type === "toml") {
    return String(file.key || "")
      .split(".")
      .reduce((current, segment) => current?.[segment], file.content);
  }
  if (file.type === "regex") {
    const match = file.source.match(file.pattern);
    return match?.groups?.version;
  }
  return file.content?.version;
}
export function currentAlphaVersionState({ cwd, refs, releasePrefix }) {
  const discovered = discoverVersionStateFiles(cwd);
  if (discovered.files.length === 0) {
    return undefined;
  }
  const versions = [
    ...new Set(
      discovered.files
        .map((file) => getVersionFileValue(file))
        .filter((version) => typeof version === "string" && version.trim()),
    ),
  ];
  if (versions.length !== 1) {
    return undefined;
  }
  const parsed = parseAlphaPrereleaseVersion(versions[0], releasePrefix);
  if (!parsed) {
    return undefined;
  }
  return {
    ...parsed,
    tag: `v${versions[0]}`,
    version: versions[0],
  };
}
export function currentReleaseVersionState({ cwd, refs, releasePrefix }) {
  const discovered = discoverVersionStateFiles(cwd);
  if (discovered.files.length === 0) {
    return undefined;
  }
  const versions = [
    ...new Set(
      discovered.files
        .map((file) => getVersionFileValue(file))
        .filter((version) => typeof version === "string" && version.trim()),
    ),
  ];
  if (versions.length !== 1) {
    return undefined;
  }
  const parsed = parseReleasePatchTag(
    `refs/tags/v${versions[0]}`,
    releasePrefix,
  );
  if (!parsed) {
    return undefined;
  }
  const stateRef = `refs/heads/${releaseTransactionStateRef(versions[0])}`;
  const hasDurableState = refs.some((ref) => ref.ref === stateRef);
  if (!hasDurableState) {
    return undefined;
  }
  return {
    ...parsed,
    tag: `v${versions[0]}`,
    version: versions[0],
  };
}
