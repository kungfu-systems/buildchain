import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  command,
  requireValue,
  runOperation,
} from "../../runtime/action-process.mjs";
const directory = ".buildchain/tail-reseal";
export function materialize(env) {
  const documents = [
    ["request.json", env.BUILDCHAIN_TAIL_RESEAL_REQUEST_JSON],
    [
      "consumer-policy-receipt.json",
      env.BUILDCHAIN_CONSUMER_POLICY_RECEIPT_JSON,
    ],
  ].map(([name, value]) => [name, JSON.parse(value)]);
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, value] of documents)
    fs.writeFileSync(
      path.join(directory, name),
      `${JSON.stringify(value, null, 2)}\n`,
    );
}
export function validatePolicyBindings({ request, receipt, env, verify }) {
  requireValue(
    request.runtime.sha === env.BUILDCHAIN_RUNTIME_SHA,
    "Tail runtime differs from job.workflow_sha",
  );
  requireValue(
    request.source.sha === env.BUILDCHAIN_SOURCE_SHA,
    "Tail source differs from the fresh workflow source",
  );
  const result = verify({
    receipt,
    receiptRoot: env.BUILDCHAIN_POLICY_ROOT,
    repository: request.repository,
    sourceSha: request.source.sha,
    resolvedRuntimeSha: request.runtime.sha,
  });
  requireValue(
    result.ok,
    `Consumer policy receipt invalid: ${(result.failures || []).map(({ code }) => code).join(", ")}`,
  );
}
export async function admitPolicy(env) {
  const { verifyFloatingConsumerPolicyReceipt } = await import(
    pathToFileURL(
      path.resolve(
        ".buildchain/runtime/packages/core/consumer/floating-consumer-policy.js",
      ),
    ).href
  );
  const read = (name) =>
    JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
  validatePolicyBindings({
    request: read("request.json"),
    receipt: read("consumer-policy-receipt.json"),
    env,
    verify: verifyFloatingConsumerPolicyReceipt,
  });
}
export function verifyReadbacks(env, read = fs.readFileSync) {
  for (const [name, expected] of [
    ["signing-provider-readback.json", env.EXPECTED_SIGNING_ROOT],
    ["release-tail-provider-readback.json", env.EXPECTED_RELEASE_TAIL_ROOT],
  ]) {
    const actual = `sha256:${crypto
      .createHash("sha256")
      .update(read(path.join(directory, name)))
      .digest("hex")}`;
    requireValue(actual === expected, `${name} root mismatch`);
  }
}
export function publicationLine(version) {
  const match = /^(\d+)\.(\d+)\.\d+-alpha\.\d+$/u.exec(version || "");
  requireValue(
    match,
    "Tail reseal requires an exact alpha publication version",
  );
  return `alpha/v${match[1]}/v${match[1]}.${match[2]}`;
}
export function aggregate(env) {
  command(
    process.execPath,
    [
      ".buildchain/runtime/packages/core/build/commands/aggregate-build-summary.mjs",
    ],
    {
      env: {
        ...env,
        BUILDCHAIN_PUBLISH_SOURCE_LINE: publicationLine(
          env.BUILDCHAIN_PUBLISH_SOURCE_CONSUMER_VERSION,
        ),
      },
    },
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runOperation({
    materialize,
    policy: admitPolicy,
    readbacks: verifyReadbacks,
    aggregate,
  });
