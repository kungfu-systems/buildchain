#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { upsertUniversalBackflow } from "../settlement/backflow.js";
const fail = message => { throw new Error(message); };
async function main() {
  const request = JSON.parse(
    process.env.BUILDCHAIN_UNIVERSAL_REQUEST_JSON ||
      fail("request is required"),
  );
  const receipt = JSON.parse(
    process.env.BUILDCHAIN_UNIVERSAL_TERMINAL_RECEIPT_JSON ||
      fail("terminal receipt is required"),
  );
  const result = await upsertUniversalBackflow({
    request,
    receipt,
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) await main();
