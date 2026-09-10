import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export function githubHeaders(token) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "buildchain-release-candidate-resolver",
    "x-github-api-version": "2022-11-28",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function githubJson({
  apiUrl,
  token,
  method = "GET",
  path: requestPath,
  fetchImpl = globalThis.fetch,
  allowNotFound = false,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is required to resolve release candidate artifacts");
  }
  const url = `${String(apiUrl || "https://api.github.com").replace(/\/+$/, "")}${requestPath}`;
  const response = await fetchImpl(url, {
    method,
    headers: githubHeaders(token),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (allowNotFound && response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `GitHub API ${method} ${requestPath} failed with ${response.status}: ${body.message || text}`,
    );
  }
  return body;
}

export async function githubDownload({
  apiUrl,
  token,
  path: requestPath,
  outputPath,
  fetchImpl = globalThis.fetch,
}) {
  const url = `${String(apiUrl || "https://api.github.com").replace(/\/+$/, "")}${requestPath}`;
  const response = await fetchImpl(url, { headers: githubHeaders(token) });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json())?.message || "";
    } catch {
      detail = "";
    }
    throw new Error(
      `GitHub artifact download ${requestPath} failed with ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  try {
    if (response.body && typeof response.body.getReader === "function") {
      await pipeline(
        Readable.fromWeb(response.body),
        fs.createWriteStream(outputPath),
      );
    } else {
      fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
    }
  } catch (error) {
    fs.rmSync(outputPath, { force: true });
    throw error;
  }
  return outputPath;
}

export function digestFileSync(filePath, algorithm, encoding) {
  const hash = crypto.createHash(algorithm);
  const descriptor = fs.openSync(filePath, "r");
  const chunk = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let bytesRead = 0;
    while (
      (bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null)) > 0
    )
      hash.update(chunk.subarray(0, bytesRead));
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest(encoding);
}

export function verifyArtifactArchive({ artifact, archivePath } = {}) {
  const size = fs.statSync(archivePath).size;
  const digest = `sha256:${digestFileSync(archivePath, "sha256", "hex")}`;
  if (!artifact || artifact.expired === true) {
    throw new Error(
      `candidate artifact is missing or expired: ${artifact?.name || "<unknown>"}`,
    );
  }
  if (Number(artifact.size_in_bytes) !== size) {
    throw new Error(
      `candidate artifact size mismatch for ${artifact.name}: expected ${artifact.size_in_bytes}, got ${size}`,
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(String(artifact.digest || ""))) {
    throw new Error(
      `candidate artifact ${artifact.name} has no trusted sha256 digest metadata`,
    );
  }
  if (String(artifact.digest).toLowerCase() !== digest) {
    throw new Error(
      `candidate artifact digest mismatch for ${artifact.name}: expected ${artifact.digest}, got ${digest}`,
    );
  }
  return { size, digest };
}

export function unzip(zipPath, outputDir) {
  const entries = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    if (
      normalized.startsWith("/") ||
      normalized.split("/").some((part) => part === "..")
    ) {
      throw new Error(
        `candidate artifact contains an unsafe zip entry: ${entry}`,
      );
    }
  }
  fs.mkdirSync(outputDir, { recursive: true });
  execFileSync("unzip", ["-q", "-o", zipPath, "-d", outputDir], {
    stdio: "inherit",
  });
}
