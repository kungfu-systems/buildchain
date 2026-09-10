import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { assertSafeRelativePath } from "./files.js";

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function encodePathSegment(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeS3Key(key) {
  return String(key || "")
    .split("/")
    .map((segment) => encodePathSegment(segment))
    .join("/");
}

function s3EndpointHost(region) {
  return String(region || "").startsWith("cn-")
    ? `s3.${region}.amazonaws.com.cn`
    : `s3.${region}.amazonaws.com`;
}

function s3RequestTarget({ bucket, key, region }) {
  const safeBucket = String(bucket || "");
  const hostSuffix = s3EndpointHost(region);
  const encodedKey = encodeS3Key(key);
  if (
    /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(safeBucket) &&
    !safeBucket.includes("..") &&
    !safeBucket.includes(".")
  ) {
    return {
      host: `${safeBucket}.${hostSuffix}`,
      path: `/${encodedKey}`,
    };
  }
  return {
    host: hostSuffix,
    path: `/${encodePathSegment(safeBucket)}/${encodedKey}`,
  };
}

function awsCredentials(credentials) {
  const { accessKeyId, secretAccessKey, sessionToken } = credentials;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required for S3 artifact relay",
    );
  }
  return { accessKeyId, secretAccessKey, sessionToken };
}

function signS3Request(
  suppliedCredentials,
  { method, bucket, key, region, payloadHash, contentLength = 0 },
) {
  if (!region) throw new Error("S3 relay region is required");
  const credentials = awsCredentials(suppliedCredentials);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const target = s3RequestTarget({ bucket, key, region });
  const headers = {
    host: target.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentLength > 0 || method === "PUT") {
    headers["content-length"] = String(contentLength);
  }
  if (credentials.sessionToken) {
    headers["x-amz-security-token"] = credentials.sessionToken;
  }
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map(
      (name) =>
        `${name}:${String(headers[name]).trim().replace(/\s+/g, " ")}\n`,
    )
    .join("");
  const canonicalRequest = [
    method,
    target.path,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");
  return {
    method,
    host: target.host,
    path: target.path,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

function requestS3(
  credentials,
  {
    method,
    bucket,
    key,
    region,
    payloadHash,
    contentLength = 0,
    bodyPath = "",
    outputPath = "",
  },
) {
  return new Promise((resolve, reject) => {
    const request = signS3Request(credentials, {
      method,
      bucket,
      key,
      region,
      payloadHash,
      contentLength,
    });
    const req = https.request(
      {
        method: request.method,
        host: request.host,
        path: request.path,
        headers: request.headers,
      },
      (res) => {
        const chunks = [];
        const output = outputPath ? fs.createWriteStream(outputPath) : null;
        if (output) {
          output.on("error", reject);
        }
        res.on("data", (chunk) => {
          if (output && res.statusCode >= 200 && res.statusCode < 300) {
            output.write(chunk);
          } else {
            chunks.push(chunk);
          }
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            if (output) {
              output.destroy();
              fs.rmSync(outputPath, { force: true });
            }
            reject(
              new Error(
                `S3 ${method} s3://${bucket}/${key} failed with HTTP ${res.statusCode}: ${body.slice(0, 500)}`,
              ),
            );
            return;
          }
          if (output) {
            output.end(resolve);
            return;
          }
          resolve();
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (bodyPath) {
      fs.createReadStream(bodyPath).on("error", reject).pipe(req);
    } else {
      req.end();
    }
  });
}

export function createS3ObjectClient({ credentials = {}, fakeRoot = "" } = {}) {
  function fakeS3Path(bucket, key) {
    if (!fakeRoot) return "";
    return path.join(
      fakeRoot,
      bucket,
      ...assertSafeRelativePath(key).split("/"),
    );
  }

  async function putS3Object({ bucket, key, region, filePath, sha256, size }) {
    const fakePath = fakeS3Path(bucket, key);
    if (fakePath) {
      fs.mkdirSync(path.dirname(fakePath), { recursive: true });
      fs.copyFileSync(filePath, fakePath);
      return;
    }
    await requestS3(credentials, {
      method: "PUT",
      bucket,
      key,
      region,
      payloadHash: sha256,
      contentLength: size,
      bodyPath: filePath,
    });
  }

  async function getS3Object({ bucket, key, region, targetPath }) {
    const fakePath = fakeS3Path(bucket, key);
    if (fakePath) {
      fs.copyFileSync(fakePath, targetPath);
      return;
    }
    await requestS3(credentials, {
      method: "GET",
      bucket,
      key,
      region,
      payloadHash: sha256Hex(""),
      outputPath: targetPath,
    });
  }

  async function deleteS3Object({ bucket, key, region }) {
    const fakePath = fakeS3Path(bucket, key);
    if (fakePath) {
      fs.rmSync(fakePath, { force: true });
      return;
    }
    await requestS3(credentials, {
      method: "DELETE",
      bucket,
      key,
      region,
      payloadHash: sha256Hex(""),
    });
  }

  return { put: putS3Object, get: getS3Object, delete: deleteS3Object };
}
