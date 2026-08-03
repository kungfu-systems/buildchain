import { assertExactFields, assertString } from "./release-propagation-common.js";

const WEB_SURFACE_EXECUTION_PROFILE_CONTRACT = "kungfu-buildchain-github-web-surface-execution";

export function normalizeExecutionProfile(value, label) {
  if (value === undefined || value === null) {
    return null;
  }
  const profile = assertExactFields(value, [
    "contract",
    "workflow",
    "productionReleaseLabel",
    "productionReleaseHeadPrefix",
    "productionStatusUrl",
    "readbackUrls",
    "updateCommand",
    "prepareCommand",
    "verifyCommand",
  ], label);
  if (profile.contract !== WEB_SURFACE_EXECUTION_PROFILE_CONTRACT) {
    throw new Error(`${label}.contract must be ${WEB_SURFACE_EXECUTION_PROFILE_CONTRACT}`);
  }
  const productionStatusUrl = assertString(profile.productionStatusUrl, `${label}.productionStatusUrl`);
  if (!/^https:\/\/[^?\s]+$/.test(productionStatusUrl)) {
    throw new Error(`${label}.productionStatusUrl must be a stable HTTPS URL without query parameters`);
  }
  if (!Array.isArray(profile.readbackUrls) || profile.readbackUrls.length === 0) {
    throw new Error(`${label}.readbackUrls must be a non-empty array`);
  }
  const readbackUrls = [...new Set(profile.readbackUrls.map((entry, index) => {
    const url = assertString(entry, `${label}.readbackUrls[${index}]`);
    if (!/^https:\/\/[^?\s]+$/.test(url)) {
      throw new Error(`${label}.readbackUrls[${index}] must be a stable HTTPS URL without query parameters`);
    }
    return url;
  }))].sort();
  if (JSON.stringify(readbackUrls) !== JSON.stringify(profile.readbackUrls)) {
    throw new Error(`${label}.readbackUrls must be sorted and unique`);
  }
  const command = (entry, field) => {
    const text = assertString(entry, `${label}.${field}`);
    if (/[\r\n]/.test(text)) {
      throw new Error(`${label}.${field} must be a single-line command`);
    }
    return text;
  };
  return {
    contract: WEB_SURFACE_EXECUTION_PROFILE_CONTRACT,
    workflow: assertString(profile.workflow, `${label}.workflow`),
    productionReleaseLabel: assertString(profile.productionReleaseLabel, `${label}.productionReleaseLabel`),
    productionReleaseHeadPrefix: assertString(profile.productionReleaseHeadPrefix, `${label}.productionReleaseHeadPrefix`),
    productionStatusUrl,
    readbackUrls,
    updateCommand: command(profile.updateCommand, "updateCommand"),
    prepareCommand: command(profile.prepareCommand, "prepareCommand"),
    verifyCommand: command(profile.verifyCommand, "verifyCommand"),
  };
}

