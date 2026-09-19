import { createHash } from "node:crypto";
import { object, relativePath, text } from "./shape.js";
import { compileConsumerPlan, CONSUMER_CONTRACT } from "./plan.js";

export function contentDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// Source identities are prepared from trusted GitHub readback, never caller inputs.
export function bindConsumerSource(source, configBytes) {
  object(
    source,
    ["repository", "commit", "tree", "configPath", "configBlob"],
    [],
    "source",
  );
  text(
    source.repository,
    "source.repository",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
  );
  for (const key of ["commit", "tree", "configBlob"])
    text(source[key], `source.${key}`, /^[0-9a-f]{40}$/u);
  relativePath(source.configPath, "source.configPath");
  const bytes = Buffer.from(configBytes);
  const blob = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (blob !== source.configBlob)
    throw new Error("source.configBlob: config bytes do not match Git blob");
  const plan = compileConsumerPlan(bytes.toString("utf8"));
  const identity = {
    schema: "buildchain.consumer-source/v1",
    repository: source.repository,
    commit: source.commit,
    tree: source.tree,
    configPath: source.configPath,
    configBlob: blob,
    configDigest: contentDigest(bytes),
    contract: CONSUMER_CONTRACT,
  };
  return {
    identity,
    identityDigest: contentDigest(JSON.stringify(identity)),
    plan,
  };
}

export function consumerContractLock({ entry, runtime, configDigest }) {
  for (const [name, value] of Object.entries({ entry, runtime })) {
    object(value, ["repository", "sha"], [], name);
    if (value.repository !== "kungfu-systems/buildchain")
      throw new Error(`${name}: untrusted Buildchain repository`);
    text(value.sha, `${name}.sha`, /^[0-9a-f]{40}$/u);
  }
  text(configDigest, "configDigest", /^sha256:[0-9a-f]{64}$/u);
  return {
    schema: "buildchain.consumer-contract-lock/v2",
    contract: CONSUMER_CONTRACT,
    entry: { ...entry },
    runtime: { ...runtime },
    configDigest,
  };
}
