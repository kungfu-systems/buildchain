#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { runDevDeliveryCommand } from "../warrant/service.js";
import { devDeliveryCliOptions } from "./dev-delivery-warrant-options.mjs";
function usage() {
  return "Usage:\n  buildchain dev warrant <fence-writer-protocol|submit|select|heartbeat|qualify|recover|close|settle|reconcile-terminal-evidence|cancel-queued|observe> --repository owner/repo --branch dev/vN/vN.M [--execute] [--output FILE] [--json]\n\nWriter protocol fence:\n  fence-writer-protocol --expected-old sha256:... [--execute]\n\nRead candidate:\n  observe --read-mode v4 --read-qualification FILE --read-qualification-root sha256:... --read-typescript-revision SHA --read-rust-revision SHA --read-validator-version TOKEN [--read-evidence-output FILE]\n";
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    process.stdout.write(usage());
    return;
  }
  const options = devDeliveryCliOptions(args);
  if (
    ![
      "fence-writer-protocol",
      "submit",
      "select",
      "heartbeat",
      "qualify",
      "recover",
      "close",
      "settle",
      "reconcile-terminal-evidence",
      "cancel-queued",
      "observe",
    ].includes(options.command)
  ) {
    throw new Error(usage().trim());
  }
  const result = await runDevDeliveryCommand(options);
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  if (options.json)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(
      `Buildchain dev delivery ${options.command}: ${result.receipt?.reason || result.mode}\n`,
    );
    process.stdout.write(
      `State root: ${result.after?.stateRoot || result.observation.stateRoot}\n`,
    );
    if (result.receiptRoot)
      process.stdout.write(`Receipt root: ${result.receiptRoot}\n`);
    process.stdout.write(`Result: ${options.outputPath}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`buildchain dev warrant: ${error.message}`);
    process.exit(1);
  });
}
