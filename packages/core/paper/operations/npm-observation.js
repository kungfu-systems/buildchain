import { commandResult } from "../paper-repository.js";
import {
  normalizedTrustedPublisher,
  trustedPublisherMatches,
} from "./provisioning-validation.js";
export function liveNpmPackageObservation(packageName, registry, cwd) {
  const result = commandResult(
    "npm",
    ["view", packageName, "version", "--json", `--registry=${registry}`],
    { cwd },
  );
  if (result.ok) {
    let version = "";
    try {
      const parsed = JSON.parse(result.stdout || '""');
      version = Array.isArray(parsed)
        ? String(parsed.at(-1) || "")
        : String(parsed || "");
    } catch {
      version = result.stdout.replace(/^"|"$/g, "");
    }
    return {
      status: "observed",
      exists: true,
      version,
      registry,
      errorCode: "",
    };
  }
  const output = `${result.stderr}\n${result.stdout}`;
  if (/\bE404\b|404 Not Found|is not in this registry/i.test(output)) {
    return {
      status: "observed",
      exists: false,
      version: "",
      registry,
      errorCode: "package-not-found",
    };
  }
  return {
    status: "unknown",
    exists: null,
    version: "",
    registry,
    errorCode: result.error ? "npm-unavailable" : "npm-view-failed",
  };
}
export function liveNpmAuthObservation(registry, cwd) {
  const result = commandResult("npm", ["whoami", `--registry=${registry}`], {
    cwd,
  });
  return {
    status: result.ok ? "authenticated" : "unauthenticated-or-unavailable",
    authenticated: result.ok,
    identity: result.ok ? result.stdout : "",
    errorCode: result.ok
      ? ""
      : result.error
        ? "npm-unavailable"
        : "npm-auth-unavailable",
  };
}
export function liveNpmTrustObservation(
  packageName,
  registry,
  cwd,
  expectedPublisher = undefined,
) {
  const result = commandResult(
    "npm",
    ["trust", "list", packageName, "--json", `--registry=${registry}`],
    { cwd },
  );
  if (!result.ok) {
    return {
      status: "unknown",
      configured: null,
      publishers: [],
      errorCode: result.error
        ? "npm-unavailable"
        : "npm-trust-query-unavailable",
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || "[]");
  } catch {
    return {
      status: "unknown",
      configured: null,
      publishers: [],
      errorCode: "npm-trust-response-invalid",
    };
  }
  const publishers = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.publishers)
      ? parsed.publishers
      : Array.isArray(parsed?.trustedPublishers)
        ? parsed.trustedPublishers
        : [];
  const normalizedPublishers = publishers.map(normalizedTrustedPublisher);
  const exactMatches = expectedPublisher
    ? normalizedPublishers.filter((entry) =>
        trustedPublisherMatches(entry, expectedPublisher),
      )
    : [];
  return {
    status: "observed",
    configured: expectedPublisher
      ? exactMatches.length === 1
      : normalizedPublishers.length > 0,
    exactBinding: expectedPublisher ? exactMatches.length === 1 : null,
    expectedPublisher: expectedPublisher || null,
    publishers: normalizedPublishers,
    errorCode: "",
  };
}
