#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FUNCTION_CODE = `function handler(event) {
  var request = event.request;
  var uri = request.uri || "/";
  if (uri.slice(-1) === "/") {
    request.uri = uri + "index.html";
  }
  return request;
}
`;

function readArg(name, fallback = "") {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return fallback;
  }
  return process.argv[index + 1] || fallback;
}

function runAws(args, { allowFailure = false } = {}) {
  const result = spawnSync("aws", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    if (allowFailure) {
      return { ok: false, stdout: "", stderr: String(result.error.message || result.error) };
    }
    throw result.error;
  }
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  if (result.status !== 0) {
    if (allowFailure) {
      return { ok: false, stdout, stderr };
    }
    throw new Error(`aws ${args.join(" ")} failed with exit code ${result.status}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }
  return { ok: true, stdout, stderr };
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

function writeFunctionCode(tmpDir) {
  const file = path.join(tmpDir, "directory-index-rewrite.js");
  fs.writeFileSync(file, FUNCTION_CODE);
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
  if (currentViewer && currentViewer.FunctionARN && currentViewer.FunctionARN !== functionArn) {
    throw new Error(
      `CloudFront distribution ${distributionId} already has a different viewer-request function ${currentViewer.FunctionARN}; ` +
      "remove or migrate it before Buildchain can manage directory-index rewrites",
    );
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
  try {
    const configFile = path.join(tmpDir, "distribution-config.json");
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    runAws([
      "cloudfront",
      "update-distribution",
      "--id",
      distributionId,
      "--if-match",
      etag,
      "--distribution-config",
      `file://${configFile}`,
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return {
    previousViewerRequestFunction: currentViewer?.FunctionARN || "",
    nextViewerRequestFunction: functionArn,
  };
}

export function ensureCloudFrontDirectoryIndexRewrite({
  distributionId = "",
  functionName = "",
  comment = "Buildchain web-surface directory index rewrite",
} = {}) {
  if (!distributionId) {
    throw new Error("--distribution-id is required");
  }
  if (!functionName) {
    throw new Error("--function-name is required");
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-cloudfront-function-"));
  try {
    const codeFile = writeFunctionCode(tmpDir);
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
    comment: readArg("comment", "Buildchain web-surface directory index rewrite"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
