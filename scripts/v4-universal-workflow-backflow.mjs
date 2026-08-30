#!/usr/bin/env node

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateV4UniversalWorkflowRequest,
  v4UniversalWorkflowRequestRoot,
} from "../packages/core/v4-universal-workflow-bootstrap.js";

const SHA = /^[0-9a-f]{40}$/u;
const ROOT = /^sha256:[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(message);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function contentRoot(domain, value) {
  const hash = crypto.createHash("sha256");
  hash.update(domain, "utf8");
  hash.update(Buffer.from([0]));
  hash.update(`${JSON.stringify(canonical(value))}\n`, "utf8");
  return `sha256:${hash.digest("hex")}`;
}

function validateTerminalReceipt(value, request) {
  if (
    value?.schema !==
      "kungfu-buildchain-v4-universal-workflow-terminal-receipt/v1" ||
    value.status !== "succeeded" ||
    value.runtime?.repository !== request.candidate.repository ||
    value.runtime?.sha !== request.candidate.expectedSha ||
    value.requestRoot !== v4UniversalWorkflowRequestRoot(request) ||
    !SHA.test(value.runtime?.sha || "") ||
    !ROOT.test(value.receiptRoot || "")
  )
    fail("successful exact-candidate terminal receipt is required for backflow");
  return value;
}

export function createV4UniversalBackflowPlan({ request: requestValue, receipt }) {
  const request = validateV4UniversalWorkflowRequest(requestValue);
  if (request.mode !== "train") fail("only Train delivery can create backflow");
  const terminal = validateTerminalReceipt(receipt, request);
  const marker = `<!-- buildchain-universal-backflow:${request.candidate.expectedSha} -->`;
  const binding = {
    schema: "kungfu-buildchain-v4-universal-workflow-backflow/v1",
    repository: request.candidate.repository,
    pullRequest: request.candidate.reviewPullRequest,
    baseRef: "dev/v4/v4.0",
    trainSha: request.candidate.expectedSha,
    consumerRepository: request.consumer.repository,
    consumerSha: request.consumer.sourceSha,
    requestRoot: terminal.requestRoot,
    terminalReceiptRoot: terminal.receiptRoot,
  };
  const backflowRoot = contentRoot("universal-workflow-backflow", binding);
  return {
    ...binding,
    marker,
    backflowRoot,
    body: [
      marker,
      "## Universal Train backflow",
      "",
      `- Train SHA: \`${binding.trainSha}\``,
      `- Consumer: \`${binding.consumerRepository}@${binding.consumerSha}\``,
      `- Request root: \`${binding.requestRoot}\``,
      `- Terminal receipt root: \`${binding.terminalReceiptRoot}\``,
      `- Backflow root: \`${backflowRoot}\``,
      "",
      "This receipt binds a successful consumer delivery to the protected Train-to-dev backflow PR; it does not designate the Train candidate as a Buildchain release.",
    ].join("\n"),
  };
}

function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "buildchain-universal-backflow",
    "x-github-api-version": "2022-11-28",
  };
}

async function githubJson({ path, method = "GET", token, body, fetchImpl }) {
  const api = String(process.env.GITHUB_API_URL || "https://api.github.com").replace(
    /\/+$/u,
    "",
  );
  const response = await fetchImpl(`${api}${path}`, {
    method,
    headers: githubHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : {};
  if (!response.ok)
    fail(`GitHub API ${method} ${path} failed with ${response.status}: ${value.message || text}`);
  return value;
}

export async function upsertV4UniversalBackflow({
  request,
  receipt,
  token,
  fetchImpl = globalThis.fetch,
}) {
  if (!token) fail("GH_TOKEN is required for protected backflow");
  if (typeof fetchImpl !== "function") fail("fetch is required for backflow");
  const plan = createV4UniversalBackflowPlan({ request, receipt });
  const encodedRepository = plan.repository;
  const pull = await githubJson({
    path: `/repos/${encodedRepository}/pulls/${plan.pullRequest}`,
    token,
    fetchImpl,
  });
  if (
    pull.state !== "open" ||
    pull.base?.ref !== plan.baseRef ||
    pull.head?.repo?.full_name !== plan.repository ||
    pull.head?.sha !== plan.trainSha
  )
    fail("backflow PR no longer binds the exact admitted Train candidate");
  const comments = await githubJson({
    path: `/repos/${encodedRepository}/issues/${plan.pullRequest}/comments?per_page=100`,
    token,
    fetchImpl,
  });
  const existing = comments.find((comment) =>
    String(comment.body || "").includes(plan.marker),
  );
  const comment = existing
    ? await githubJson({
        path: `/repos/${encodedRepository}/issues/comments/${existing.id}`,
        method: "PATCH",
        token,
        body: { body: plan.body },
        fetchImpl,
      })
    : await githubJson({
        path: `/repos/${encodedRepository}/issues/${plan.pullRequest}/comments`,
        method: "POST",
        token,
        body: { body: plan.body },
        fetchImpl,
      });
  return {
    schema: "kungfu-buildchain-v4-universal-workflow-backflow-result/v1",
    action: existing ? "updated" : "created",
    pullRequest: plan.pullRequest,
    trainSha: plan.trainSha,
    terminalReceiptRoot: plan.terminalReceiptRoot,
    backflowRoot: plan.backflowRoot,
    commentUrl: comment.html_url,
  };
}

async function main() {
  const request = JSON.parse(
    process.env.BUILDCHAIN_UNIVERSAL_REQUEST_JSON || fail("request is required"),
  );
  const receipt = JSON.parse(
    process.env.BUILDCHAIN_UNIVERSAL_TERMINAL_RECEIPT_JSON ||
      fail("terminal receipt is required"),
  );
  const result = await upsertV4UniversalBackflow({
    request,
    receipt,
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) await main();
