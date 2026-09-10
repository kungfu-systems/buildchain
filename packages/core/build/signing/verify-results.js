import { required, resolveSigningPath, signingFilesNamed } from "./files.js";
import fs from "node:fs";
import path from "node:path";

import { validateArtifactSigningRequest } from "../artifact-signing.js";
import { verifyArtifactSigningResultFiles } from "../artifact-signing-result.js";

function resolveRequestRoot(root) {
  const direct = path.join(root, "index.json");
  if (fs.existsSync(direct)) return root;
  const candidates = signingFilesNamed(root, "index.json").filter(
    (candidate) => {
      try {
        return (
          JSON.parse(fs.readFileSync(candidate, "utf8")).contract ===
          "kungfu-buildchain-artifact-signing-request-index/v1"
        );
      } catch {
        return false;
      }
    },
  );
  if (candidates.length !== 1) {
    throw new Error(
      `expected exactly one artifact signing request index, found ${candidates.length}`,
    );
  }
  return path.dirname(candidates[0]);
}

export function verifyArtifactSigningResults({ requestRoot, resultRoot } = {}) {
  const requests = resolveRequestRoot(
    path.resolve(required(requestRoot, "signing request root")),
  );
  const results = path.resolve(required(resultRoot, "signing result root"));
  const requestIndex = JSON.parse(
    fs.readFileSync(path.join(requests, "index.json"), "utf8"),
  );
  const resultIndex = JSON.parse(
    fs.readFileSync(path.join(results, "index.json"), "utf8"),
  );
  if (
    requestIndex.contract !==
    "kungfu-buildchain-artifact-signing-request-index/v1"
  ) {
    throw new Error("artifact signing request index contract mismatch");
  }
  if (
    resultIndex.contract !==
    "kungfu-buildchain-artifact-signing-result-index/v1"
  ) {
    throw new Error("artifact signing result index contract mismatch");
  }
  const expected = new Map(
    (requestIndex.requests || []).map((entry) => [entry.id, entry]),
  );
  const verified = [];
  for (const entry of resultIndex.results || []) {
    const requestEntry = expected.get(entry.id);
    if (!requestEntry)
      throw new Error(`unexpected signing result: ${entry.id}`);
    const request = JSON.parse(
      fs.readFileSync(
        resolveSigningPath(requests, requestEntry.path, "request path"),
        "utf8",
      ),
    );
    const requestCheck = validateArtifactSigningRequest(request);
    if (!requestCheck.ok || request.digest !== requestEntry.digest) {
      throw new Error(`invalid sealed signing request: ${entry.id}`);
    }
    const resultPath = resolveSigningPath(results, entry.result, "result path");
    const resultDirectory = path.dirname(resultPath);
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    const receipt = JSON.parse(
      fs.readFileSync(
        resolveSigningPath(
          resultDirectory,
          result.receipt.path,
          "receipt path",
        ),
        "utf8",
      ),
    );
    const check = verifyArtifactSigningResultFiles({
      root: resultDirectory,
      request,
      receipt,
      result,
    });
    if (!check.ok) {
      throw new Error(
        `invalid signing result ${entry.id}: ${check.issues.join(", ")}`,
      );
    }
    if (
      entry.requestDigest !== request.digest ||
      entry.resultDigest !== result.digest
    ) {
      throw new Error(`signing result index binding mismatch: ${entry.id}`);
    }
    expected.delete(entry.id);
    verified.push({ id: entry.id, resultDigest: result.digest });
  }
  const missingRequired = [...expected.values()].filter(
    (entry) => entry.required !== false,
  );
  if (missingRequired.length > 0) {
    throw new Error(
      `missing required signing results: ${missingRequired.map((entry) => entry.id).join(", ")}`,
    );
  }
  const outputs = {
    "verified-count": String(verified.length),
    "verified-result-root": results,
  };
  return { ok: true, verified, outputs };
}
