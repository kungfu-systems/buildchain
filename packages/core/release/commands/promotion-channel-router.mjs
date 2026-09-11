#!/usr/bin/env node
import fs from "node:fs";
import { parseArgs } from "node:util";
import { resolvePromotionChannel } from "../promotion/channel.js";

try {
  const { values } = parseArgs({ options: {
    "target-ref": { type: "string" },
    "publication-channel": { type: "string" },
  }});
  const result = resolvePromotionChannel({ targetRef: values["target-ref"], publicationChannel: values["publication-channel"] });
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
    Object.entries({ "target-ref": result.targetRef, "publication-channel": result.publicationChannel, channel: result.channel }).map(([k,v]) => `${k}=${v}\n`).join(""));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  console.error(`promotion-channel-router: ${error.message}`);
  process.exitCode = 1;
}
