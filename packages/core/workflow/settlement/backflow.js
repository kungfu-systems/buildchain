import crypto from "node:crypto";
import {
  validateUniversalWorkflowRequest,
  universalWorkflowRequestRoot,
} from "../universal-workflow-bootstrap.js";
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
    value.requestRoot !== universalWorkflowRequestRoot(request) ||
    !SHA.test(value.runtime?.sha || "") ||
    !ROOT.test(value.receiptRoot || "")
  )
    fail(
      "successful exact-candidate terminal receipt is required for backflow",
    );
  return value;
}

export function createUniversalBackflowPlan({
  request: requestValue,
  receipt,
}) {
  const request = validateUniversalWorkflowRequest(requestValue);
  if (request.mode !== "train") fail("only Train delivery can create backflow");
  if (request.capability.id !== "release-candidate-promote")
    fail("only a release-candidate-promote delivery can create backflow");
  if (request.payload?.inputs?.["dry-run"] !== false)
    fail("only a non-dry-run release delivery can create backflow");
  const terminal = validateTerminalReceipt(receipt, request);
  const marker = `<!-- buildchain-universal-backflow:${request.candidate.expectedSha} -->`;
  const binding = {
    schema: "kungfu-buildchain-v4-universal-workflow-backflow/v1",
    repository: request.candidate.repository,
    pullRequest: request.candidate.reviewPullRequest,
    baseRef: "dev/v4/v4.1",
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
  const api = String(
    process.env.GITHUB_API_URL || "https://api.github.com",
  ).replace(/\/+$/u, "");
  const response = await fetchImpl(`${api}${path}`, {
    method,
    headers: githubHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : {};
  if (!response.ok)
    fail(
      `GitHub API ${method} ${path} failed with ${response.status}: ${value.message || text}`,
    );
  return value;
}

export async function upsertUniversalBackflow({
  request,
  receipt,
  token,
  fetchImpl = globalThis.fetch,
}) {
  const admitted = validateUniversalWorkflowRequest(request);
  if (
    admitted.mode !== "train" ||
    admitted.capability.id !== "release-candidate-promote" ||
    admitted.payload?.inputs?.["dry-run"] !== false
  ) {
    return {
      schema: "kungfu-buildchain-v4-universal-workflow-backflow-result/v1",
      action: "skipped",
      reason: "not-a-successful-non-dry-run-release-delivery",
      backflowRoot: "",
    };
  }
  if (!token) fail("GH_TOKEN is required for protected backflow");
  if (typeof fetchImpl !== "function") fail("fetch is required for backflow");
  const plan = createUniversalBackflowPlan({ request: admitted, receipt });
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
