import fs from "node:fs";
import { readReleaseDiscussion } from "./reader.js";
export { readReleaseDiscussion } from "./reader.js";
export { decodeRecord } from "./envelope.js";

// The published self-contained reader accepts only captured JSON on stdin.
// Run with Node's permission model: no network, child process or file writes.
if (typeof require !== "undefined" && require.main === module) {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  process.stdout.write(`${JSON.stringify(readReleaseDiscussion(input))}\n`);
}
