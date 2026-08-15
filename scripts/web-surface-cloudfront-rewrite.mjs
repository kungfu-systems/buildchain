#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REDIRECT_STATUS_DESCRIPTIONS = new Map([
  [301, "Moved Permanently"],
  [302, "Found"],
  [307, "Temporary Redirect"],
  [308, "Permanent Redirect"],
]);

export function renderCloudFrontViewerRequestFunction(redirects = []) {
  const redirectMap = Object.fromEntries(redirects.map((redirect) => [
    redirect.source,
    {
      statusCode: redirect.status,
      statusDescription: REDIRECT_STATUS_DESCRIPTIONS.get(redirect.status),
      target: redirect.target,
    },
  ]));
  return `var redirects = ${JSON.stringify(redirectMap)};
function handler(event) {
  var request = event.request;
  var uri = request.uri || "/";
  var redirect = redirects[uri];
  if (redirect) {
    return {
      statusCode: redirect.statusCode,
      statusDescription: redirect.statusDescription,
      headers: {
        location: { value: redirect.target },
        "cache-control": { value: "no-store" }
      }
    };
  }
  if (uri.slice(-1) === "/") {
    request.uri = uri + "index.html";
  }
  return request;
}
`;
}

const DISTRIBUTION_UPDATE_MAX_ATTEMPTS = 3;
const DISTRIBUTION_UPDATE_RETRY_DELAY_MS = 250;

function readArg(name, fallback = "") {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return fallback;
  }
  return process.argv[index + 1] || fallback;
}

function parseRedirectsBase64(value = "") {
  if (!value) return [];
  let redirects;
  try {
    redirects = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    throw new Error("--redirects-base64 must encode a JSON redirect array");
  }
  if (!Array.isArray(redirects)) {
    throw new Error("--redirects-base64 must encode a JSON redirect array");
  }
  return redirects.map((redirect, index) => {
    const label = `redirects[${index}]`;
    if (!redirect || typeof redirect !== "object" || Array.isArray(redirect)) {
      throw new Error(`${label} must be an object`);
    }
    if (typeof redirect.source !== "string" || !redirect.source.startsWith("/") || redirect.source.startsWith("//")) {
      throw new Error(`${label}.source must be one root-relative request path`);
    }
    if (typeof redirect.target !== "string" || !redirect.target.startsWith("https://")) {
      throw new Error(`${label}.target must be one absolute HTTPS URL`);
    }
    if (!REDIRECT_STATUS_DESCRIPTIONS.has(redirect.status)) {
      throw new Error(`${label}.status must be one of 301, 302, 307, or 308`);
    }
    return {
      source: redirect.source,
      target: redirect.target,
      status: redirect.status,
    };
  });
}

function runAws(args, { allowFailure = false } = {}) {
  const result = spawnSync("aws", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    if (allowFailure) {
      return { ok: false, status: null, stdout: "", stderr: String(result.error.message || result.error) };
    }
    throw result.error;
  }
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  if (result.status !== 0) {
    if (allowFailure) {
      return { ok: false, status: result.status, stdout, stderr };
    }
    throw new Error(`aws ${args.join(" ")} failed with exit code ${result.status}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }
  return { ok: true, status: result.status, stdout, stderr };
}

function runAwsJson(args, options = {}) {
  const result = runAws([...args, "--output", "json"], options);
  if (!result.ok) {
    return { ok: false, data: null, stderr: result.stderr };
  }
  return { ok: true, data: result.stdout.trim() ? JSON.parse(result.stdout) : {}, stderr: result.stderr };
}

function functionConfig(comment) {
  return `Comment=${comment.replace(/,/g, " ")},Runtime=cloudfront-js-2.0`;
}

function awsFailureMessage(args, result) {
  const status = result.status === null || result.status === undefined
    ? ""
    : ` with exit code ${result.status}`;
  const stderr = String(result.stderr || "").trim();
  return `aws ${args.join(" ")} failed${status}${stderr ? `: ${stderr}` : ""}`;
}

function isStaleDistributionEtag(result) {
  return result.ok === false && /\bPreconditionFailed\b/.test(String(result.stderr || ""));
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function writeFunctionCode(tmpDir, redirects) {
  const file = path.join(tmpDir, "directory-index-rewrite.js");
  fs.writeFileSync(file, renderCloudFrontViewerRequestFunction(redirects));
  return file;
}

function ensureFunction({ name, comment, codeFile }) {
  const described = runAwsJson(["cloudfront", "describe-function", "--name", name, "--stage", "DEVELOPMENT"], {
    allowFailure: true,
  });
  if (!described.ok) {
    const created = runAwsJson([
      "cloudfront",
      "create-function",
      "--name",
      name,
      "--function-config",
      functionConfig(comment),
      "--function-code",
      `fileb://${codeFile}`,
    ]);
    return {
      etag: created.data?.ETag || "",
      action: "created",
    };
  }
  const etag = described.data?.ETag || "";
  if (!etag) {
    throw new Error(`cloudfront describe-function did not return an ETag for ${name}`);
  }
  const updated = runAwsJson([
    "cloudfront",
    "update-function",
    "--name",
    name,
    "--if-match",
    etag,
    "--function-config",
    functionConfig(comment),
    "--function-code",
    `fileb://${codeFile}`,
  ]);
  return {
    etag: updated.data?.ETag || etag,
    action: "updated",
  };
}

function publishFunction({ name, etag }) {
  if (!etag) {
    throw new Error(`cloudfront publish-function requires an ETag for ${name}`);
  }
  const published = runAwsJson([
    "cloudfront",
    "publish-function",
    "--name",
    name,
    "--if-match",
    etag,
  ]);
  const summary = published.data?.FunctionSummary || {};
  const arn = summary.FunctionMetadata?.FunctionARN || summary.FunctionARN || "";
  if (!arn) {
    throw new Error(`cloudfront publish-function did not return a FunctionARN for ${name}`);
  }
  return {
    arn,
    etag: published.data?.ETag || etag,
  };
}

function attachFunction({ distributionId, functionArn }) {
  let previousViewerRequestFunction;
  for (let attempt = 1; attempt <= DISTRIBUTION_UPDATE_MAX_ATTEMPTS; attempt += 1) {
    const current = runAwsJson(["cloudfront", "get-distribution-config", "--id", distributionId]);
    const etag = current.data?.ETag || "";
    const config = current.data?.DistributionConfig;
    if (!etag || !config) {
      throw new Error(`cloudfront get-distribution-config did not return ETag and DistributionConfig for ${distributionId}`);
    }
    const defaultBehavior = config.DefaultCacheBehavior || {};
    const existing = defaultBehavior.FunctionAssociations || { Quantity: 0, Items: [] };
    const items = Array.isArray(existing.Items) ? [...existing.Items] : [];
    const currentViewer = items.find((item) => item.EventType === "viewer-request");
    if (previousViewerRequestFunction === undefined) {
      previousViewerRequestFunction = currentViewer?.FunctionARN || "";
    }
    if (currentViewer && currentViewer.FunctionARN && currentViewer.FunctionARN !== functionArn) {
      throw new Error(
        `CloudFront distribution ${distributionId} already has a different viewer-request function ${currentViewer.FunctionARN}; ` +
        "remove or migrate it before Buildchain can manage directory-index rewrites",
      );
    }
    if (currentViewer?.FunctionARN === functionArn) {
      return {
        previousViewerRequestFunction,
        nextViewerRequestFunction: functionArn,
      };
    }

    const nextItems = [
      ...items.filter((item) => item.EventType !== "viewer-request"),
      {
        EventType: "viewer-request",
        FunctionARN: functionArn,
      },
    ];
    config.DefaultCacheBehavior = {
      ...defaultBehavior,
      FunctionAssociations: {
        Quantity: nextItems.length,
        Items: nextItems,
      },
    };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-cloudfront-distribution-"));
    let args;
    let updated;
    try {
      const configFile = path.join(tmpDir, "distribution-config.json");
      fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
      args = [
        "cloudfront",
        "update-distribution",
        "--id",
        distributionId,
        "--if-match",
        etag,
        "--distribution-config",
        `file://${configFile}`,
      ];
      updated = runAws(args, { allowFailure: true });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    if (updated.ok) {
      return {
        previousViewerRequestFunction,
        nextViewerRequestFunction: functionArn,
      };
    }
    if (!isStaleDistributionEtag(updated)) {
      throw new Error(awsFailureMessage(args, updated));
    }
    if (attempt === DISTRIBUTION_UPDATE_MAX_ATTEMPTS) {
      throw new Error(
        `CloudFront update-distribution still failed after ${attempt} attempts: ${awsFailureMessage(args, updated)}`,
      );
    }
    sleepSync(DISTRIBUTION_UPDATE_RETRY_DELAY_MS * attempt);
  }
  throw new Error(`CloudFront update-distribution retry loop ended unexpectedly for ${distributionId}`);
}

export function ensureCloudFrontDirectoryIndexRewrite({
  distributionId = "",
  functionName = "",
  comment = "Buildchain web-surface viewer request routing",
  redirects = [],
} = {}) {
  if (!distributionId) {
    throw new Error("--distribution-id is required");
  }
  if (!functionName) {
    throw new Error("--function-name is required");
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-cloudfront-function-"));
  try {
    const codeFile = writeFunctionCode(tmpDir, redirects);
    const ensured = ensureFunction({ name: functionName, comment, codeFile });
    const published = publishFunction({ name: functionName, etag: ensured.etag });
    const attached = attachFunction({ distributionId, functionArn: published.arn });
    return {
      schemaVersion: 1,
      contract: "kungfu-buildchain-web-surface-cloudfront-directory-index-rewrite",
      distributionId,
      functionName,
      functionAction: ensured.action,
      functionArn: published.arn,
      redirects,
      ...attached,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const result = ensureCloudFrontDirectoryIndexRewrite({
    distributionId: readArg("distribution-id"),
    functionName: readArg("function-name"),
    comment: readArg("comment", "Buildchain web-surface viewer request routing"),
    redirects: parseRedirectsBase64(readArg("redirects-base64")),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
