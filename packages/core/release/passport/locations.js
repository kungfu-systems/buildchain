import path from "node:path";
import fs from "node:fs";
import { readJsonFile } from "./files.js";
import https from "node:https";
import http from "node:http";
import { nonEmptyString } from "./identity.js";
export async function resolveSiblingJson(basePath, relativePath) {
  if (!basePath || !relativePath) {
    return undefined;
  }
  if (/^https?:\/\//.test(relativePath)) {
    return readJsonFromLocation(relativePath);
  }
  if (/^https?:\/\//.test(basePath)) {
    return readJsonFromLocation(new URL(relativePath, basePath).toString());
  }
  const candidate = path.resolve(path.dirname(basePath), relativePath);
  if (!fs.existsSync(candidate)) {
    return undefined;
  }
  return readJsonFile(candidate);
}
export async function readJsonFromLocation(
  location,
  redirectCount = 0,
  { timeoutMs = 15_000 } = {},
) {
  const input = nonEmptyString(location, "location");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive integer");
  }
  if (redirectCount > 5) {
    throw new Error(`too many redirects while reading ${input}`);
  }
  if (/^https?:\/\//.test(input)) {
    const client = input.startsWith("https:") ? https : http;
    return new Promise((resolve, reject) => {
      const request = client.get(input, (response) => {
        if (
          [301, 302, 303, 307, 308].includes(response.statusCode) &&
          response.headers.location
        ) {
          const nextLocation = new URL(
            response.headers.location,
            input,
          ).toString();
          response.resume();
          readJsonFromLocation(nextLocation, redirectCount + 1, {
            timeoutMs,
          }).then(resolve, reject);
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(
            new Error(`HTTP ${response.statusCode} while reading ${input}`),
          );
          response.resume();
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      });
      request.setTimeout(timeoutMs, () => {
        request.destroy(
          new Error(`timed out after ${timeoutMs}ms while reading ${input}`),
        );
      });
      request.on("error", reject);
    });
  }
  return readJsonFile(input);
}
