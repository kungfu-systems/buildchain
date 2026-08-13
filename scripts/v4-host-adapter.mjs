#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { architectureList, architectureShow } from "./v4-architecture.mjs";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const SUPPORTED_CAPABILITIES = Object.freeze([
  "architecture-read-v1",
  "cancellation-v1",
  "canonical-input-v1",
  "diagnostics-v1",
  "exit-semantics-v1",
  "structured-result-v1",
]);

function encodedBytes(value = Buffer.alloc(0)) {
  return { encoding: "base64", bytes: Buffer.from(value).toString("base64") };
}

function response(request, overrides = {}) {
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-v4-host-response",
    protocolVersion: "1.0",
    requestId: request.requestId,
    status: "ok",
    host: {
      kind: "node-subprocess",
      implementation: "buildchain-v4-mjs-adapter",
      capabilities: [...SUPPORTED_CAPABILITIES],
    },
    command: request.command,
    output: {
      stdout: encodedBytes(),
      stderr: encodedBytes(),
    },
    structuredResult: null,
    diagnostics: [],
    exit: { code: 0, signal: null },
    ...overrides,
  };
}

function validateRequest(request) {
  if (
    request?.schemaVersion !== 1 ||
    request?.contract !== "kungfu-buildchain-v4-host-request" ||
    request?.protocolVersion !== "1.0"
  ) {
    throw new Error("unsupported Buildchain v4 host request contract");
  }
  if (!request.requestId || !request.command?.id) {
    throw new Error("requestId and command.id must be non-empty");
  }
  if (
    request.input?.encoding !== "base64" ||
    typeof request.input?.bytes !== "string"
  ) {
    throw new Error("input must contain canonical base64 bytes");
  }
  Buffer.from(request.input.bytes, "base64");
}

function unsupportedResponse(request, unsupported) {
  const message = `unsupported host capabilities: ${unsupported.join(", ")}`;
  return response(request, {
    status: "unsupported",
    output: { stdout: encodedBytes(), stderr: encodedBytes(`${message}\n`) },
    diagnostics: [
      { code: "unsupported-capability", message, retryable: false },
    ],
    exit: { code: 64, signal: null },
  });
}

async function dispatch(request, root = process.cwd()) {
  validateRequest(request);
  const unsupported = request.requiredCapabilities.filter(
    (capability) => !SUPPORTED_CAPABILITIES.includes(capability),
  );
  if (unsupported.length > 0) return unsupportedResponse(request, unsupported);

  const args = request.command.arguments;
  if (request.command.id === "architecture.list") {
    const result = architectureList(root);
    return response(request, {
      output: {
        stdout: encodedBytes(
          `${JSON.stringify(result, null, args.includes("--json") ? 2 : 0)}\n`,
        ),
        stderr: encodedBytes(),
      },
      structuredResult: result,
    });
  }
  if (request.command.id === "architecture.show") {
    const id = args.find((entry) => !entry.startsWith("--"));
    try {
      const result = architectureShow(id, root);
      return response(request, {
        output: {
          stdout: encodedBytes(
            `${JSON.stringify(result, null, args.includes("--json") ? 2 : 0)}\n`,
          ),
          stderr: encodedBytes(),
        },
        structuredResult: result,
      });
    } catch (error) {
      const message = `buildchain architecture: ${error.message}`;
      return response(request, {
        status: "failed",
        output: {
          stdout: encodedBytes(),
          stderr: encodedBytes(`${message}\n`),
        },
        diagnostics: [
          { code: "legacy-command-failed", message, retryable: false },
        ],
        exit: { code: 1, signal: null },
      });
    }
  }
  if (request.command.id === "fixture.echo") {
    const input = Buffer.from(request.input.bytes, "base64");
    return response(request, {
      output: { stdout: encodedBytes(input), stderr: encodedBytes() },
      structuredResult: { bytes: input.length },
    });
  }
  if (request.command.id === "fixture.fail") {
    return response(request, {
      status: "failed",
      output: {
        stdout: encodedBytes("partial-output\n"),
        stderr: encodedBytes("controlled fixture failure\n"),
      },
      structuredResult: { failureClass: "controlled" },
      diagnostics: [
        {
          code: "fixture-controlled-failure",
          message: "controlled fixture failure",
          retryable: false,
        },
      ],
      exit: { code: 42, signal: null },
    });
  }
  if (request.command.id === "fixture.wait") {
    const delay = Number.parseInt(args[0] || "10000", 10);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return response(request, {
      structuredResult: { waitedMs: delay },
    });
  }
  if (request.command.id === "fixture.crash") process.exit(86);
  return unsupportedResponse(request, [`command:${request.command.id}`]);
}

async function main() {
  const serialized = fs.readFileSync(0);
  if (serialized.length > MAX_REQUEST_BYTES) {
    throw new Error(`host request exceeds ${MAX_REQUEST_BYTES} bytes`);
  }
  const request = JSON.parse(serialized.toString("utf8"));
  const result = await dispatch(request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`buildchain v4 host: ${error.message}\n`);
    process.exitCode = 70;
  });
}

export { SUPPORTED_CAPABILITIES, dispatch, response, validateRequest };
