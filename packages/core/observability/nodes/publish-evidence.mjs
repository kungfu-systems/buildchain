import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  command,
  requireValue,
  runOperation,
} from "../../runtime/action-process.mjs";

const receipt = ".buildchain/observed-evidence/receipt.json";
export function evidenceArguments(env, mode) {
  requireValue(
    ["verify", "publish"].includes(mode),
    "Unknown observed evidence operation",
  );
  const input = JSON.parse(env.BUILDCHAIN_EVIDENCE_REQUEST_JSON);
  const args = [
    ".buildchain/runtime/packages/core/observability/commands/observed-evidence.mjs",
    "--manifest",
    input["manifest-path"],
    "--artifact-root",
    input["artifact-path"],
    "--bucket",
    input["production-bucket"],
  ];
  if (mode === "publish")
    args.push(
      "--distribution-id",
      input["cloudfront-distribution"],
      "--execute",
      "true",
      "--output",
      receipt,
    );
  return args;
}
export function publishEvidence(env, execute = command) {
  const args = evidenceArguments(env, "publish");
  fs.mkdirSync(".buildchain/observed-evidence", { recursive: true });
  execute(process.execPath, args);
  requireValue(
    fs.existsSync(receipt),
    "Observed evidence publication did not produce its receipt",
  );
  fs.appendFileSync(env.GITHUB_OUTPUT, `receipt-path=${receipt}\n`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runOperation({
    verify: (env) =>
      command(process.execPath, evidenceArguments(env, "verify")),
    publish: publishEvidence,
  });
}
